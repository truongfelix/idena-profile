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
//   c:<name>            -> epoch its holder was found without the right to hold it (challenge)
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

/** Epochs a challenged holder has to come back before the name is freed. */
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

export class IdenaProfile {
  holders: PersistentMap<string, string>
  names: PersistentMap<string, string>
  renamed: PersistentMap<string, string>
  blocked: PersistentMap<string, string>
  challenges: PersistentMap<string, string>
  bios: PersistentMap<string, string>
  pictures: PersistentMap<string, string>
  trusts: PersistentMap<string, string>
  counts: PersistentMap<string, string>
  vouchedCounts: PersistentMap<string, string>
  offers: PersistentMap<string, string>
  vouchers: PersistentMap<string, string>
  members: PersistentMap<string, string>
  memberCounts: PersistentMap<string, string>
  identities: PersistentMap<string, string>

  constructor() {
    this.holders = PersistentMap.withStringPrefix<string, string>('n:')
    this.names = PersistentMap.withStringPrefix<string, string>('a:')
    this.renamed = PersistentMap.withStringPrefix<string, string>('r:')
    this.blocked = PersistentMap.withStringPrefix<string, string>('x:')
    this.challenges = PersistentMap.withStringPrefix<string, string>('c:')
    this.bios = PersistentMap.withStringPrefix<string, string>('b:')
    this.pictures = PersistentMap.withStringPrefix<string, string>('p:')
    this.trusts = PersistentMap.withStringPrefix<string, string>('t:')
    this.counts = PersistentMap.withStringPrefix<string, string>('k:')
    this.vouchedCounts = PersistentMap.withStringPrefix<string, string>('w:')
    this.offers = PersistentMap.withStringPrefix<string, string>('o:')
    this.vouchers = PersistentMap.withStringPrefix<string, string>('v:')
    this.members = PersistentMap.withStringPrefix<string, string>('m:')
    this.memberCounts = PersistentMap.withStringPrefix<string, string>('q:')
    this.identities = PersistentMap.withStringPrefix<string, string>('i:')
  }

  // ---- Names

  /** Claims a free name, or renames (at most once per epoch; the old name stays blocked). */
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
    const name = this.names.get(address, '')
    util.assert(name != '', 'no name')
    this.release(name, Context.epoch())
    this.names.delete(address)
    Host.emitEvent('name', [caller.toBytes(), Bytes.fromString(''), Bytes.fromString(name)])
  }

  /**
   * Records that the holder of `name` may no longer hold it (anyone may call it): neither validated nor vouched for
   * by a validated identity. A holder in good standing clears it.
   */
  @mutateState
  challengeName(args: NameArgs): void {
    const holderHex = this.holders.get(args.name, '')
    util.assert(holderHex != '', 'no such name')
    const holder = addressOf(holderHex)
    if (this.ensureKnown(this.withVoucher(holder), '_challengeName', [holder.toBytes(), Bytes.fromString(args.name)], args._gas))
      this.doChallengeName(holder, args.name)
  }

  @mutateState
  _challengeName(asked: Address, holder: Address, name: string): void {
    this.keep(asked)
    this.doChallengeName(holder, name)
  }

  /** Frees a challenged name GRACE_EPOCHS after the challenge if its holder still may not hold it. */
  @mutateState
  releaseName(args: NameArgs): void {
    const since = this.challenges.get(args.name, '')
    util.assert(since != '', 'not challenged')
    util.assert(Context.epoch() >= parseEpoch(since) + GRACE_EPOCHS, 'the grace is not over')
    const holder = addressOf(this.holders.get(args.name, ''))
    if (this.ensureKnown(this.withVoucher(holder), '_releaseName', [holder.toBytes(), Bytes.fromString(args.name)], args._gas))
      this.doReleaseName(holder, args.name)
  }

  @mutateState
  _releaseName(asked: Address, holder: Address, name: string): void {
    this.keep(asked)
    this.doReleaseName(holder, name)
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
    const given = this.trusts.get(key, '')
    util.assert(given != '', 'not trusted')
    this.trusts.delete(key)
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
    util.assert(this.vouchers.get(args.member, '') != hex(caller), 'already vouched for')
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
    util.assert(this.offers.get(hex(caller) + ':' + args.voucher, '') != '', 'no such offer')
    util.assert(this.vouchers.get(hex(caller), '') == '', 'already vouched for')
    const voucher = addressOf(args.voucher)
    if (this.ensureKnown([caller, voucher], '_acceptVouch', [caller.toBytes(), voucher.toBytes()], args._gas))
      this.doAcceptVouch(caller, voucher)
  }

  @mutateState
  _acceptVouch(asked: Address, member: Address, voucher: Address): void {
    this.keep(asked)
    this.doAcceptVouch(member, voucher)
  }

  /** Ends the vouch for `member` (by its voucher) or the caller's own (by the member, `member` empty). */
  @mutateState
  endVouch(args: MemberArgs): void {
    const caller = hex(Context.caller())
    const member = args.member == '' ? caller : args.member
    const voucher = this.vouchers.get(member, '')
    util.assert(voucher != '' && (caller == member || caller == voucher), 'no such vouch')
    this.removeVouch(member, voucher)
  }

  /** The voucher withdraws an offer not accepted yet. An offer takes no slot: the cap counts accepted vouches. */
  @mutateState
  cancelOffer(args: MemberArgs): void {
    const caller = Context.caller()
    const key = args.member + ':' + hex(caller)
    util.assert(this.offers.get(key, '') != '', 'no such offer')
    this.offers.delete(key)
    Host.emitEvent('vouchOfferEnded', [caller.toBytes(), Bytes.fromString(args.member)])
  }

  /** The member refuses an offer. */
  @mutateState
  declineOffer(args: VoucherArgs): void {
    const caller = Context.caller()
    const key = hex(caller) + ':' + args.voucher
    util.assert(this.offers.get(key, '') != '', 'no such offer')
    this.offers.delete(key)
    Host.emitEvent('vouchOfferEnded', [Bytes.fromString(args.voucher), caller.toBytes()])
  }

  // ---- What each call does once the states it needs are known

  private doClaimName(holder: Address, name: string): void {
    util.assert(this.standing(holder, false) != NONE, 'neither validated nor vouched for')
    this.checkFree(name)
    const address = hex(holder)
    const epoch = Context.epoch()
    const old = this.names.get(address, '')
    if (old != '') {
      util.assert(parseEpoch(this.renamed.get(address, '0')) < epoch, 'one name change per epoch')
      this.release(old, epoch)
    }
    this.holders.set(name, address)
    this.names.set(address, name)
    this.renamed.set(address, epochText(epoch))
    Host.emitEvent('name', [holder.toBytes(), Bytes.fromString(name), Bytes.fromString(old)])
  }

  private doChallengeName(holder: Address, name: string): void {
    if (this.standing(holder, false) != NONE) {
      this.challenges.delete(name)
      Host.emitEvent('challenge', [Bytes.fromString(name), Bytes.fromString('')])
      return
    }
    if (this.challenges.get(name, '') == '') {
      const epoch = epochText(Context.epoch())
      this.challenges.set(name, epoch)
      Host.emitEvent('challenge', [Bytes.fromString(name), Bytes.fromString(epoch)])
    }
  }

  private doReleaseName(holder: Address, name: string): void {
    this.challenges.delete(name)
    if (this.standing(holder, false) != NONE) {
      Host.emitEvent('challenge', [Bytes.fromString(name), Bytes.fromString('')])
      return
    }
    this.holders.delete(name)
    this.names.delete(hex(holder))
    Host.emitEvent('released', [Bytes.fromString(name), Bytes.fromString(hex(holder))])
  }

  private doSetProfile(holder: Address, bio: string, picture: string): void {
    util.assert(this.standing(holder, false) != NONE, 'neither validated nor vouched for')
    this.checkProfile(bio, picture)
    const address = hex(holder)
    if (bio == '') this.bios.delete(address)
    else this.bios.set(address, bio)
    if (picture == '') this.pictures.delete(address)
    else this.pictures.set(address, picture)
    Host.emitEvent('profile', [holder.toBytes(), Bytes.fromString(bio), Bytes.fromString(picture)])
  }

  private doTrust(giver: Address, target: string): void {
    const standing = this.standing(giver, true)
    util.assert(standing != NONE, 'neither validated nor vouched for')
    const key = target + ':' + hex(giver)
    util.assert(this.trusts.get(key, '') == '', 'already trusted')
    const asMember = standing == VOUCHED
    this.trusts.set(key, epochText(Context.epoch()) + (asMember ? ':v' : ''))
    this.addTrustCount(target, asMember, 1)
    Host.emitEvent('trust', [giver.toBytes(), Bytes.fromString(target), Bytes.fromString(asMember ? 'vouched' : '')])
  }

  private doVouch(voucher: Address, member: string): void {
    const state = this.stateOf(voucher)
    util.assert(validated(state), 'only a validated identity vouches')
    const count = U32.parseInt(this.memberCounts.get(hex(voucher), '0'))
    util.assert(count < vouchCap(state), 'no vouch left')
    this.offers.set(member + ':' + hex(voucher), epochText(Context.epoch()))
    Host.emitEvent('vouchOffered', [voucher.toBytes(), Bytes.fromString(member)])
  }

  private doAcceptVouch(member: Address, voucher: Address): void {
    util.assert(vouchable(this.stateOf(member)), 'only an account without an identity can be vouched for')
    const voucherState = this.stateOf(voucher)
    util.assert(validated(voucherState), 'the voucher is not validated')
    const count = U32.parseInt(this.memberCounts.get(hex(voucher), '0'))
    util.assert(count < vouchCap(voucherState), 'the voucher has no vouch left')
    this.offers.delete(hex(member) + ':' + hex(voucher))
    this.vouchers.set(hex(member), hex(voucher))
    this.members.set(hex(voucher) + ':' + hex(member), epochText(Context.epoch()))
    this.memberCounts.set(hex(voucher), (count + 1).toString())
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
    const voucher = this.vouchers.get(hex(account), '')
    if (voucher != '' && !vouchable(state)) this.removeVouch(hex(account), voucher)
    if (forTrust ? canTrust(state) : validated(state)) return OWN
    if (voucher != '' && vouchable(state) && validated(this.stateOf(addressOf(voucher)))) return VOUCHED
    return NONE
  }

  /** The account, and its voucher if it has one: the states its standing needs. */
  private withVoucher(account: Address): Address[] {
    const list: Address[] = [account]
    const voucher = this.vouchers.get(hex(account), '')
    if (voucher != '') list.push(addressOf(voucher))
    return list
  }

  /**
   * A vouched member's call (one with a voucher and no identity known to allow it) burns what it sends, at least
   * about one more call's fee.
   */
  private payIfVouched(account: Address): void {
    if (this.vouchers.get(hex(account), '') == '') return
    const state = this.knownState(account)
    if (state >= 0 && !vouchable(<u32>state)) return
    const paid = Context.payAmount()
    util.assert(paid >= vouchedExtra(), 'a vouched member sends about one more fee with each call')
    Host.burn(paid)
  }

  private removeVouch(member: string, voucher: string): void {
    this.vouchers.delete(member)
    this.members.delete(voucher + ':' + member)
    const left = plus(this.memberCounts.get(voucher, '0'), -1)
    if (left == '') this.memberCounts.delete(voucher)
    else this.memberCounts.set(voucher, left)
    Host.emitEvent('vouchEnded', [Bytes.fromString(voucher), Bytes.fromString(member)])
  }

  private addTrustCount(target: string, asMember: bool, delta: i64): void {
    const counts = asMember ? this.vouchedCounts : this.counts
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
    for (let i = 0; i < accounts.length; i++) if (this.knownState(accounts[i]) < 0) unknown.push(accounts[i])
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
    const saved = this.identities.get(hex(address), '')
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
    this.identities.set(hex(address), epochText(Context.epoch()) + ':' + promisedState().toString())
  }

  // ---- Checks

  private checkFree(name: string): void {
    util.assert(validName(name, 20), 'a-z, 0-9 and _, 3 to 20 characters')
    util.assert(this.holders.get(name, '') == '', 'name taken')
    const until = this.blocked.get(name, '')
    util.assert(until == '' || Context.epoch() >= parseEpoch(until), 'name blocked for now')
  }

  private checkProfile(bio: string, picture: string): void {
    util.assert(bio.length <= MAX_BIO, 'bio too long')
    util.assert(
      picture == '' || (picture.startsWith('ipfs://') && picture.length <= MAX_PICTURE && validCid(picture.slice(7))),
      'picture: ipfs://<cid>'
    )
  }

  private release(name: string, epoch: u16): void {
    this.holders.delete(name)
    this.challenges.delete(name)
    this.blocked.set(name, epochText(epoch + BLOCKED_EPOCHS))
  }
}
