// Idena profiles: one unique name, a short bio and a picture per validated identity, Trust, a public vouch counted
// per person and per topic, and vouched members: a validated identity vouches for accounts that are not validated
// yet, which may then hold a name, write a profile and give Trust. No owner and no upgrade: a later version lives at
// another address.
//
// The identity of an address is read with a promise (the node answers it after the call) and kept for the rest of
// the epoch. A call that needs states not read yet asks for each; the node answers them in order, each followed by
// its callback: the earlier ones keep their state, the last one acts with all of them known. The VM runs a callback
// only as a promise's answer.
//
// Storage, every value a string (contract_readMap / contract_iterateMap with the "string" format):
//   n:<name>            -> holder address (0x..., lowercase)
//   a:<address>         -> its name
//   r:<address>         -> epoch of its last name change
//   x:<name>            -> epoch from which a dropped or renamed name can be claimed again
//   c:<name>:<challenger> -> "<since>:<last>:<holder>": the challenger found the holder without the right to hold the
//                          name in each epoch from <since> to <last>; from <since> + GRACE_EPOCHS it takes the name
//   b:<address>         -> bio
//   p:<address>         -> picture ("ipfs://<cid>")
//   t:<target>:<giver>  -> epoch the Trust was given, then ":v" when given as a vouched member; target = an address
//                          or "r/<topic>"
//   k:<target>          -> Trusts given to it by identities; w:<target> -> by vouched members (the apps count only
//                          givers still in good standing)
//   o:<member>:<voucher> -> epoch a vouch was offered: the member accepts or declines it, the voucher may cancel
//                          it; it takes no slot (the cap counts accepted vouches)
//   v:<member>          -> its voucher, once accepted
//   m:<voucher>:<member> -> epoch the member accepted; q:<voucher> -> how many members it vouches for
//   e:<voucher>         -> "<epoch>:<count>": vouches it started in that epoch (at most its cap, ended ones included)
//   i:<address>         -> "<epoch>:<state>": its identity state as read in that epoch
import {Address, Bytes, Context, Host, Balance, PersistentMap, u128, util, models} from 'idena-sdk-as'
import {Protobuf} from 'as-proto'

// Identity states (idena-go core/state).
const UNDEFINED: u32 = 0
const INVITE: u32 = 1
const CANDIDATE: u32 = 2
const VERIFIED: u32 = 3
const SUSPENDED: u32 = 4
const KILLED: u32 = 5
const ZOMBIE: u32 = 6
const NEWBIE: u32 = 7
const HUMAN: u32 = 8

const IDENTITY_GAS: u32 = 20_000
const DEFAULT_CALLBACK_GAS: u32 = 10_000_000
const KEEP_STATE_GAS: u32 = 10_000_000

/**
 * Epochs a challenged holder has to come back: the challenger finds the holder without the right to hold the name in
 * this many epochs after the first, each one in a row, then takes it.
 */
const GRACE_EPOCHS: u16 = 2
/** Epochs a dropped or renamed name stays blocked. */
const BLOCKED_EPOCHS: u16 = 2
const MAX_BIO = 160
const MAX_PICTURE = 120
/** A vouched member's call burns about one more call's fee: this much gas at the network's minimum fee per gas. */
const VOUCHED_EXTRA_GAS: u64 = 25_000

/** A validated identity: it may hold a name, write a profile and vouch. */
function validated(state: u32): bool {
  return state == NEWBIE || state == VERIFIED || state == HUMAN
}

/** May give Trust on its own: validated, or able to come back at the next validation. */
function canTrust(state: u32): bool {
  return validated(state) || state == SUSPENDED || state == ZOMBIE
}

/** May be vouched for: no identity of its own. */
function vouchable(state: u32): bool {
  return state == UNDEFINED || state == INVITE || state == CANDIDATE || state == KILLED
}

/** How many members an identity may vouch for at once. */
function vouchCap(state: u32): u32 {
  if (state == HUMAN) return 5
  if (state == VERIFIED) return 3
  if (state == NEWBIE) return 1
  return 0
}

/** a-z, 0-9 and _, 3 to 20 characters (a topic: 3 to 21). */
function validName(name: string, max: i32): bool {
  if (name.length < 3 || name.length > max) return false
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i)
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c == 95)) return false
  }
  return true
}

function validAddress(text: string): bool {
  if (text.length != 42 || !text.startsWith('0x')) return false
  for (let i = 2; i < 42; i++) {
    const c = text.charCodeAt(i)
    if (!((c >= 97 && c <= 102) || (c >= 48 && c <= 57))) return false
  }
  return true
}

/** A Trust target: a lowercase address, or "r/<topic>". */
function validTarget(target: string): bool {
  if (target.startsWith('r/')) return validName(target.slice(2), 21)
  return validAddress(target)
}

function validCid(cid: string): bool {
  if (cid.length < 10) return false
  for (let i = 0; i < cid.length; i++) {
    const c = cid.charCodeAt(i)
    if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57))) return false
  }
  return true
}

function hex(address: Address): string {
  return util.toHexString(address, true).toLowerCase()
}

function addressOf(text: string): Address {
  return Address.fromBytes(util.decodeFromHex(text))
}

function epochText(epoch: u16): string {
  return epoch.toString()
}

function parseEpoch(text: string): u16 {
  return <u16>U32.parseInt(text)
}

function plus(text: string, delta: i64): string {
  const next = I64.parseInt(text == '' ? '0' : text) + delta
  return next <= 0 ? '' : next.toString()
}

/**
 * The identity state a callback was given. The node answers "empty" for an address without an identity, Killed
 * ones included (idena-go deletes them): that is Undefined.
 */
function promisedState(): u32 {
  const res = Host.promiseResult()
  util.assert(!res.failed(), 'the identity could not be read')
  if (res.empty() || res.value().length == 0) return UNDEFINED
  const identity = Protobuf.decode<models.ProtoStateIdentity>(res.value(), models.ProtoStateIdentity.decode)
  return identity.state
}

/** The first epoch of a saved challenge, "<since>:<last>:<holder>". */
function challengeSince(saved: string): u16 {
  return parseEpoch(saved.slice(0, saved.indexOf(':')))
}

/** What a vouched member sends with a call, burned: about one more call's fee. */
function vouchedExtra(): Balance {
  return new Balance(u128.mul(Context.minFeePerGas().value, u128.fromU64(VOUCHED_EXTRA_GAS)))
}

class NameArgs {
  name: string = ''
  _gas: u32 = DEFAULT_CALLBACK_GAS
}

class ProfileArgs {
  bio: string = ''
  picture: string = ''
  _gas: u32 = DEFAULT_CALLBACK_GAS
}

class TrustArgs {
  target: string = ''
  _gas: u32 = DEFAULT_CALLBACK_GAS
}

class MemberArgs {
  member: string = ''
  _gas: u32 = DEFAULT_CALLBACK_GAS
}

class VoucherArgs {
  voucher: string = ''
  _gas: u32 = DEFAULT_CALLBACK_GAS
}

/** How an account acts: on its own identity, as a vouched member, or not at all. */
const OWN: i32 = 1
const VOUCHED: i32 = 2
const NONE: i32 = 0

/**
 * The storage maps, built at each call: outside the contract object, which the SDK reads and writes whole at every
 * call and callback (each map in it cost its prefix's bytes in each).
 */
class Maps {
  holders: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('n:')
  names: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('a:')
  renamed: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('r:')
  blocked: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('x:')
  challenges: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('c:')
  bios: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('b:')
  pictures: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('p:')
  trusts: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('t:')
  counts: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('k:')
  vouchedCounts: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('w:')
  offers: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('o:')
  vouchers: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('v:')
  members: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('m:')
  memberCounts: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('q:')
  identities: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('i:')
  epochVouches: PersistentMap<string, string> = PersistentMap.withStringPrefix<string, string>('e:')
}
const maps = new Maps()

export class IdenaProfile {
  /** Deploys the contract: it keeps no state of its own besides the maps. */
  constructor() {}

  // ---- Names

  /** Claims a free name, or renames (one name claimed per epoch; the old name stays blocked). */
  @mutateState
  claimName(args: NameArgs): void {
    this.checkFree(args.name)
    const caller = Context.caller()
    this.payIfVouched(caller)
    if (this.ensureKnown(this.withVoucher(caller), '_claimName', [caller.toBytes(), Bytes.fromString(args.name)], args._gas))
      this.doClaimName(caller, args.name)
  }

  @mutateState
  _claimName(asked: Address, holder: Address, name: string): void {
    this.keep(asked)
    this.doClaimName(holder, name)
  }

  /** Drops the caller's name; it stays blocked for a while. */
  @mutateState
  dropName(): void {
    const caller = Context.caller()
    const address = hex(caller)
    const name = maps.names.get(address, '')
    util.assert(name != '', 'no name')
    this.release(name, Context.epoch())
    maps.names.delete(address)
    Host.emitEvent('name', [caller.toBytes(), Bytes.fromString(''), Bytes.fromString(name)])
  }

  /**
   * Finds that the holder of `name` may no longer hold it: neither validated nor vouched for by a validated identity.
   * The caller calls it once in each epoch, in a row; a holder found in good standing ends that challenge, and a
   * missed epoch starts it again. From GRACE_EPOCHS after the first, the call frees the name and claims it for the
   * caller (when the caller may claim a name in this epoch; else it only counts the epoch).
   */
  @mutateState
  challengeName(args: NameArgs): void {
    const holderHex = maps.holders.get(args.name, '')
    util.assert(holderHex != '', 'no such name')
    const caller = Context.caller()
    util.assert(holderHex != hex(caller), 'cannot challenge oneself')
    this.payIfVouched(caller)
    const holder = addressOf(holderHex)
    const accounts = this.withVoucher(holder)
    if (this.challengeEnds(args.name, hex(caller), holderHex)) {
      const own = this.withVoucher(caller)
      for (let i = 0; i < own.length; i++) accounts.push(own[i])
    }
    if (this.ensureKnown(accounts, '_challengeName', [caller.toBytes(), Bytes.fromString(args.name)], args._gas))
      this.doChallengeName(caller, args.name)
  }

  @mutateState
  _challengeName(asked: Address, challenger: Address, name: string): void {
    this.keep(asked)
    this.doChallengeName(challenger, name)
  }

  // ---- Profile

  /** Sets the caller's bio and picture (empty removes them). */
  @mutateState
  setProfile(args: ProfileArgs): void {
    this.checkProfile(args.bio, args.picture)
    const caller = Context.caller()
    this.payIfVouched(caller)
    const callArgs = [caller.toBytes(), Bytes.fromString(args.bio), Bytes.fromString(args.picture)]
    if (this.ensureKnown(this.withVoucher(caller), '_setProfile', callArgs, args._gas))
      this.doSetProfile(caller, args.bio, args.picture)
  }

  @mutateState
  _setProfile(asked: Address, holder: Address, bio: string, picture: string): void {
    this.keep(asked)
    this.doSetProfile(holder, bio, picture)
  }

  // ---- Trust

  /** Trusts a person (a lowercase address) or a topic ("r/name"), once. */
  @mutateState
  trust(args: TrustArgs): void {
    util.assert(validTarget(args.target), 'not an address or a topic')
    const caller = Context.caller()
    util.assert(args.target != hex(caller), 'cannot trust oneself')
    this.payIfVouched(caller)
    if (this.ensureKnown(this.withVoucher(caller), '_trust', [caller.toBytes(), Bytes.fromString(args.target)], args._gas))
      this.doTrust(caller, args.target)
  }

  @mutateState
  _trust(asked: Address, giver: Address, target: string): void {
    this.keep(asked)
    this.doTrust(giver, target)
  }

  /** Takes a Trust back. */
  @mutateState
  untrust(args: TrustArgs): void {
    const caller = Context.caller()
    const key = args.target + ':' + hex(caller)
    const given = maps.trusts.get(key, '')
    util.assert(given != '', 'not trusted')
    maps.trusts.delete(key)
    this.addTrustCount(args.target, given.endsWith(':v'), -1)
    Host.emitEvent('untrust', [caller.toBytes(), Bytes.fromString(args.target)])
  }

  // ---- Vouching

  /** Offers to vouch for `member`, an account without an identity; it becomes a vouch once the member accepts it. */
  @mutateState
  vouch(args: MemberArgs): void {
    util.assert(validAddress(args.member), 'not an address')
    const caller = Context.caller()
    util.assert(args.member != hex(caller), 'cannot vouch for oneself')
    util.assert(maps.vouchers.get(args.member, '') != hex(caller), 'already vouched for')
    if (this.ensureKnown([caller], '_vouch', [caller.toBytes(), Bytes.fromString(args.member)], args._gas))
      this.doVouch(caller, args.member)
  }

  @mutateState
  _vouch(asked: Address, voucher: Address, member: string): void {
    this.keep(asked)
    this.doVouch(voucher, member)
  }

  /** Accepts a vouch offered to the caller. */
  @mutateState
  acceptVouch(args: VoucherArgs): void {
    util.assert(validAddress(args.voucher), 'not an address')
    const caller = Context.caller()
    util.assert(maps.offers.get(hex(caller) + ':' + args.voucher, '') != '', 'no such offer')
    util.assert(maps.vouchers.get(hex(caller), '') == '', 'already vouched for')
    const voucher = addressOf(args.voucher)
    if (this.ensureKnown([caller, voucher], '_acceptVouch', [caller.toBytes(), voucher.toBytes()], args._gas))
      this.doAcceptVouch(caller, voucher)
  }

  @mutateState
  _acceptVouch(asked: Address, member: Address, voucher: Address): void {
    this.keep(asked)
    this.doAcceptVouch(member, voucher)
  }

  /**
   * Ends the vouch for `member` (by its voucher) or the caller's own (by the member, `member` empty). As for an
   * identity that lost its status, nothing is deleted: the apps stop showing its name, bio, picture and Trusts, which
   * come back if it is vouched for again; its name can be challenged meanwhile.
   */
  @mutateState
  endVouch(args: MemberArgs): void {
    const caller = hex(Context.caller())
    const member = args.member == '' ? caller : args.member
    const voucher = maps.vouchers.get(member, '')
    util.assert(voucher != '' && (caller == member || caller == voucher), 'no such vouch')
    this.removeVouch(member, voucher)
  }

  /** The voucher withdraws an offer not accepted yet. An offer takes no slot: the cap counts accepted vouches. */
  @mutateState
  cancelOffer(args: MemberArgs): void {
    const caller = Context.caller()
    const key = args.member + ':' + hex(caller)
    util.assert(maps.offers.get(key, '') != '', 'no such offer')
    maps.offers.delete(key)
    Host.emitEvent('vouchOfferEnded', [caller.toBytes(), Bytes.fromString(args.member)])
  }

  /** The member refuses an offer. */
  @mutateState
  declineOffer(args: VoucherArgs): void {
    const caller = Context.caller()
    const key = hex(caller) + ':' + args.voucher
    util.assert(maps.offers.get(key, '') != '', 'no such offer')
    maps.offers.delete(key)
    Host.emitEvent('vouchOfferEnded', [Bytes.fromString(args.voucher), caller.toBytes()])
  }

  // ---- What each call does once the states it needs are known

  private doClaimName(holder: Address, name: string): void {
    util.assert(this.standing(holder, false) != NONE, 'neither validated nor vouched for')
    this.checkFree(name)
    const address = hex(holder)
    const epoch = Context.epoch()
    const last = maps.renamed.get(address, '')
    util.assert(last == '' || parseEpoch(last) < epoch, 'one name change per epoch')
    const old = maps.names.get(address, '')
    if (old != '') this.release(old, epoch)
    maps.holders.set(name, address)
    maps.names.set(address, name)
    maps.renamed.set(address, epochText(epoch))
    Host.emitEvent('name', [holder.toBytes(), Bytes.fromString(name), Bytes.fromString(old)])
  }

  private doChallengeName(challenger: Address, name: string): void {
    const holderHex = maps.holders.get(name, '')
    const holder = addressOf(holderHex)
    const key = name + ':' + hex(challenger)
    if (this.standing(holder, false) != NONE) {
      maps.challenges.delete(key)
      Host.emitEvent('challenge', [Bytes.fromString(name), challenger.toBytes(), Bytes.fromString('')])
      return
    }
    const epoch = Context.epoch()
    const ends = this.challengeEnds(name, hex(challenger), holderHex)
    const since = this.challengeGoesOn(name, hex(challenger), holderHex) ? challengeSince(maps.challenges.get(key, '')) : epoch
    maps.challenges.set(key, epochText(since) + ':' + epochText(epoch) + ':' + holderHex)
    Host.emitEvent('challenge', [Bytes.fromString(name), challenger.toBytes(), Bytes.fromString(epochText(since))])
    if (!ends || !this.mayClaim(challenger)) return
    maps.challenges.delete(key)
    maps.holders.delete(name)
    maps.names.delete(holderHex)
    Host.emitEvent('released', [Bytes.fromString(name), Bytes.fromString(holderHex)])
    this.doClaimName(challenger, name)
  }

  private doSetProfile(holder: Address, bio: string, picture: string): void {
    util.assert(this.standing(holder, false) != NONE, 'neither validated nor vouched for')
    this.checkProfile(bio, picture)
    const address = hex(holder)
    if (bio == '') maps.bios.delete(address)
    else maps.bios.set(address, bio)
    if (picture == '') maps.pictures.delete(address)
    else maps.pictures.set(address, picture)
    Host.emitEvent('profile', [holder.toBytes(), Bytes.fromString(bio), Bytes.fromString(picture)])
  }

  private doTrust(giver: Address, target: string): void {
    const standing = this.standing(giver, true)
    util.assert(standing != NONE, 'neither validated nor vouched for')
    const key = target + ':' + hex(giver)
    util.assert(maps.trusts.get(key, '') == '', 'already trusted')
    const asMember = standing == VOUCHED
    maps.trusts.set(key, epochText(Context.epoch()) + (asMember ? ':v' : ''))
    this.addTrustCount(target, asMember, 1)
    Host.emitEvent('trust', [giver.toBytes(), Bytes.fromString(target), Bytes.fromString(asMember ? 'vouched' : '')])
  }

  private doVouch(voucher: Address, member: string): void {
    const state = this.stateOf(voucher)
    util.assert(validated(state), 'only a validated identity vouches')
    const count = U32.parseInt(maps.memberCounts.get(hex(voucher), '0'))
    util.assert(count < vouchCap(state), 'no vouch left')
    maps.offers.set(member + ':' + hex(voucher), epochText(Context.epoch()))
    Host.emitEvent('vouchOffered', [voucher.toBytes(), Bytes.fromString(member)])
  }

  private doAcceptVouch(member: Address, voucher: Address): void {
    util.assert(vouchable(this.stateOf(member)), 'only an account without an identity can be vouched for')
    const voucherState = this.stateOf(voucher)
    util.assert(validated(voucherState), 'the voucher is not validated')
    const count = U32.parseInt(maps.memberCounts.get(hex(voucher), '0'))
    util.assert(count < vouchCap(voucherState), 'the voucher has no vouch left')
    const epoch = Context.epoch()
    const started = this.vouchesThisEpoch(hex(voucher))
    util.assert(started < vouchCap(voucherState), 'the voucher has no vouch left in this epoch')
    maps.epochVouches.set(hex(voucher), epochText(epoch) + ':' + (started + 1).toString())
    maps.offers.delete(hex(member) + ':' + hex(voucher))
    maps.vouchers.set(hex(member), hex(voucher))
    maps.members.set(hex(voucher) + ':' + hex(member), epochText(Context.epoch()))
    maps.memberCounts.set(hex(voucher), (count + 1).toString())
    Host.emitEvent('vouched', [voucher.toBytes(), member.toBytes()])
  }

  // ---- Standing

  /**
   * How `account` acts (all states it needs known): OWN when its identity allows it (`forTrust`: Suspended and
   * Zombie too), VOUCHED when it has no identity and its voucher is validated, else NONE. A member who got an
   * identity leaves its voucher's list.
   */
  private standing(account: Address, forTrust: bool): i32 {
    const state = this.stateOf(account)
    const voucher = maps.vouchers.get(hex(account), '')
    if (voucher != '' && !vouchable(state)) this.removeVouch(hex(account), voucher)
    if (forTrust ? canTrust(state) : validated(state)) return OWN
    if (voucher != '' && vouchable(state) && validated(this.stateOf(addressOf(voucher)))) return VOUCHED
    return NONE
  }

  /** The account, and its voucher if it has one: the states its standing needs. */
  private withVoucher(account: Address): Address[] {
    const list: Address[] = [account]
    const voucher = maps.vouchers.get(hex(account), '')
    if (voucher != '') list.push(addressOf(voucher))
    return list
  }

  /**
   * A vouched member's call (one with a voucher and no identity known to allow it) burns what it sends, at least
   * about one more call's fee. Any other call never reads the amount: on a node, a call sent without one carries
   * none, and reading it fails in the VM (pay_amount). An amount sent by mistake stays in the contract.
   */
  private payIfVouched(account: Address): void {
    if (maps.vouchers.get(hex(account), '') == '') return
    const state = this.knownState(account)
    if (state >= 0 && !vouchable(<u32>state)) return
    const paid = Context.payAmount()
    util.assert(paid >= vouchedExtra(), 'a vouched member sends about one more fee with each call')
    Host.burn(paid)
  }

  /** The challenge of `challenger` on `name` counts the previous epoch for the same holder: it goes on. */
  private challengeGoesOn(name: string, challenger: string, holder: string): bool {
    const saved = maps.challenges.get(name + ':' + challenger, '')
    if (saved == '') return false
    const parts = saved.split(':')
    return parts.length == 3 && parts[2] == holder && <i32>parseEpoch(parts[1]) + 1 >= <i32>Context.epoch()
  }

  /** This epoch's finding ends the challenge: it goes on, and the grace is over. */
  private challengeEnds(name: string, challenger: string, holder: string): bool {
    if (!this.challengeGoesOn(name, challenger, holder)) return false
    const since = challengeSince(maps.challenges.get(name + ':' + challenger, ''))
    return <i32>Context.epoch() >= <i32>since + <i32>GRACE_EPOCHS
  }

  /** The account (its states read) may claim a name now: in good standing, no name claimed in this epoch. */
  private mayClaim(account: Address): bool {
    if (this.knownState(account) < 0 || this.standing(account, false) == NONE) return false
    const last = maps.renamed.get(hex(account), '')
    return last == '' || parseEpoch(last) < Context.epoch()
  }

  /** How many vouches `voucher` started in this epoch (ended ones included). */
  private vouchesThisEpoch(voucher: string): u32 {
    const saved = maps.epochVouches.get(voucher, '')
    const colon = saved.indexOf(':')
    if (colon < 0 || parseEpoch(saved.slice(0, colon)) != Context.epoch()) return 0
    return U32.parseInt(saved.slice(colon + 1))
  }

  private removeVouch(member: string, voucher: string): void {
    maps.vouchers.delete(member)
    maps.members.delete(voucher + ':' + member)
    const left = plus(maps.memberCounts.get(voucher, '0'), -1)
    if (left == '') maps.memberCounts.delete(voucher)
    else maps.memberCounts.set(voucher, left)
    Host.emitEvent('vouchEnded', [Bytes.fromString(voucher), Bytes.fromString(member)])
  }

  private addTrustCount(target: string, asMember: bool, delta: i64): void {
    const counts = asMember ? maps.vouchedCounts : maps.counts
    const next = plus(counts.get(target, '0'), delta)
    if (next == '') counts.delete(target)
    else counts.set(target, next)
  }

  // ---- Identity states, read once per epoch

  /**
   * Asks the node for the states of `accounts` not read yet in this epoch; the last answer's callback (`callback`,
   * with the asked address then `args`) acts. True when all are known already: the caller acts at once.
   */
  private ensureKnown(accounts: Address[], callback: string, args: Bytes[], gas: u32): bool {
    const unknown: Address[] = []
    for (let i = 0; i < accounts.length; i++) {
      let again = false
      for (let j = 0; j < i; j++) if (hex(accounts[j]) == hex(accounts[i])) again = true
      if (!again && this.knownState(accounts[i]) < 0) unknown.push(accounts[i])
    }
    if (unknown.length == 0) return true
    for (let i = 0; i < unknown.length; i++) {
      const last = i == unknown.length - 1
      const callArgs: Bytes[] = [unknown[i].toBytes()]
      if (last) for (let j = 0; j < args.length; j++) callArgs.push(args[j])
      Host.createGetIdentityPromise(unknown[i], IDENTITY_GAS).then(
        last ? callback : '_keepState',
        callArgs,
        Balance.Zero,
        last ? gas : KEEP_STATE_GAS
      )
    }
    return false
  }

  /** An earlier answer of several: its state is kept for the callback that acts. */
  @mutateState
  _keepState(asked: Address): void {
    this.keep(asked)
  }

  /**
   * The identity state of `address` read earlier in this epoch, or -1. States change at a validation (a new epoch),
   * except a termination in the middle of one: a terminated identity keeps its state here until the epoch ends.
   */
  private knownState(address: Address): i32 {
    const saved = maps.identities.get(hex(address), '')
    const colon = saved.indexOf(':')
    if (colon < 0 || parseEpoch(saved.slice(0, colon)) != Context.epoch()) return -1
    return <i32>U32.parseInt(saved.slice(colon + 1))
  }

  /** A state that must be known (read in this epoch). */
  private stateOf(address: Address): u32 {
    const state = this.knownState(address)
    util.assert(state >= 0, 'identity not read')
    return <u32>state
  }

  /** Keeps the state the identity promise gave for `address` for the rest of the epoch. */
  private keep(address: Address): void {
    maps.identities.set(hex(address), epochText(Context.epoch()) + ':' + promisedState().toString())
  }

  // ---- Checks

  private checkFree(name: string): void {
    util.assert(validName(name, 20), 'a-z, 0-9 and _, 3 to 20 characters')
    util.assert(maps.holders.get(name, '') == '', 'name taken')
    const until = maps.blocked.get(name, '')
    util.assert(until == '' || Context.epoch() >= parseEpoch(until), 'name blocked for now')
  }

  private checkProfile(bio: string, picture: string): void {
    util.assert(bio.length <= MAX_BIO, 'bio too long')
    util.assert(
      picture == '' || (picture.startsWith('ipfs://') && picture.length <= MAX_PICTURE && validCid(picture.slice(7))),
      'picture: ipfs://<cid>'
    )
  }

  /** A dropped, renamed or forfeited name: free, blocked for a while. Challenges on it end with the holder's change. */
  private release(name: string, epoch: u16): void {
    maps.holders.delete(name)
    maps.blocked.set(name, epochText(epoch + BLOCKED_EPOCHS))
  }
}
