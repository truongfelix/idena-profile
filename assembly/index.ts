// Idena profiles: one unique name, a short bio and a picture per validated identity, and Trust, a public vouch
// counted per person and per topic. No owner and no upgrade: a later version lives at another address.
//
// The identity of an address is read with a promise (the node answers it after the call): each method that needs
// it asks for it, and its callback checks the state and writes. A callback acts only on a promise's answer: called
// any other way it sees no value and refuses.
//
// Storage, every value a string (contract_readMap / contract_iterateMap with the "string" format):
//   n:<name>          -> holder address (0x..., lowercase)
//   a:<address>       -> its name
//   r:<address>       -> epoch of its last name change
//   x:<name>          -> epoch from which a dropped or renamed name can be claimed again
//   c:<name>          -> epoch its holder was found not validated (challenge)
//   b:<address>       -> bio
//   p:<address>       -> picture ("ipfs://<cid>")
//   t:<target>:<giver> -> epoch the Trust was given; target = an address or "r/<topic>"
//   k:<target>        -> number of Trusts given to it (the apps count only givers still validated)
import {Address, Bytes, Context, Host, Balance, PersistentMap, util, models} from 'idena-sdk-as'
import {Protobuf} from 'as-proto'

// Identity states (idena-go core/state).
const VERIFIED: u32 = 3
const SUSPENDED: u32 = 4
const ZOMBIE: u32 = 6
const NEWBIE: u32 = 7
const HUMAN: u32 = 8

const IDENTITY_GAS: u32 = 20_000
const DEFAULT_CALLBACK_GAS: u32 = 10_000_000

/** Epochs a challenged holder has to validate again before the name is freed. */
const GRACE_EPOCHS: u16 = 2
/** Epochs a dropped or renamed name stays blocked. */
const BLOCKED_EPOCHS: u16 = 2
const MAX_BIO = 160
const MAX_PICTURE = 120

const RESERVED: string[] = [
  'idena', 'idena_network', 'idenanetwork', 'idena_social', 'idenasocial', 'admin', 'administrator', 'support',
  'help', 'official', 'moderator', 'mod', 'staff', 'team', 'system', 'root', 'null', 'undefined', 'god', 'foundation',
]

/** Who may hold a name and write a profile: a validated identity. */
function canHoldName(state: u32): bool {
  return state == NEWBIE || state == VERIFIED || state == HUMAN
}

/** Who may give Trust, and whose Trust counts: validated, or able to come back at the next validation. */
function canTrust(state: u32): bool {
  return canHoldName(state) || state == SUSPENDED || state == ZOMBIE
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

function hex(address: Address): string {
  return util.toHexString(address, true).toLowerCase()
}

function epochText(epoch: u16): string {
  return epoch.toString()
}

function parseEpoch(text: string): u16 {
  return <u16>U32.parseInt(text)
}

/** The identity a callback was given; aborts when it was not called with a promise's answer. */
function promisedState(): u32 {
  const res = Host.promiseResult()
  util.assert(!res.failed() && !res.empty() && res.value().length > 0, 'no identity')
  const identity = Protobuf.decode<models.ProtoStateIdentity>(res.value(), models.ProtoStateIdentity.decode)
  return identity.state
}

function askIdentity(address: Address, callback: string, args: Bytes[], gas: u32): void {
  Host.createGetIdentityPromise(address, IDENTITY_GAS).then(callback, args, Balance.Zero, gas)
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
  }

  // ---- Names

  /** Claims a free name, or renames (at most once per epoch; the old name stays blocked). */
  @mutateState
  claimName(args: NameArgs): void {
    this.checkFree(args.name)
    const caller = Context.caller()
    askIdentity(caller, '_claimName', [caller.toBytes(), Bytes.fromString(args.name)], args._gas)
  }

  @mutateState
  _claimName(holder: Address, name: string): void {
    util.assert(canHoldName(promisedState()), 'not a validated identity')
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

  /** Records that the holder of `name` is not validated (anyone may call it); a validated holder clears it. */
  @mutateState
  challengeName(args: NameArgs): void {
    const holder = this.holders.get(args.name, '')
    util.assert(holder != '', 'no such name')
    askIdentity(Address.fromBytes(util.decodeFromHex(holder)), '_challengeName', [Bytes.fromString(args.name)], args._gas)
  }

  @mutateState
  _challengeName(name: string): void {
    const state = promisedState()
    if (canHoldName(state)) {
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

  /** Frees a challenged name GRACE_EPOCHS after the challenge if its holder is still not validated. */
  @mutateState
  releaseName(args: NameArgs): void {
    const since = this.challenges.get(args.name, '')
    util.assert(since != '', 'not challenged')
    util.assert(Context.epoch() >= parseEpoch(since) + GRACE_EPOCHS, 'the grace is not over')
    const holder = this.holders.get(args.name, '')
    askIdentity(Address.fromBytes(util.decodeFromHex(holder)), '_releaseName', [Bytes.fromString(args.name)], args._gas)
  }

  @mutateState
  _releaseName(name: string): void {
    const state = promisedState()
    this.challenges.delete(name)
    if (canHoldName(state)) {
      Host.emitEvent('challenge', [Bytes.fromString(name), Bytes.fromString('')])
      return
    }
    const holder = this.holders.get(name, '')
    this.holders.delete(name)
    this.names.delete(holder)
    Host.emitEvent('released', [Bytes.fromString(name), Bytes.fromString(holder)])
  }

  // ---- Profile

  /** Sets the caller's bio and picture (empty removes them). */
  @mutateState
  setProfile(args: ProfileArgs): void {
    this.checkProfile(args.bio, args.picture)
    const caller = Context.caller()
    askIdentity(
      caller,
      '_setProfile',
      [caller.toBytes(), Bytes.fromString(args.bio), Bytes.fromString(args.picture)],
      args._gas
    )
  }

  @mutateState
  _setProfile(holder: Address, bio: string, picture: string): void {
    util.assert(canHoldName(promisedState()), 'not a validated identity')
    this.checkProfile(bio, picture)
    const address = hex(holder)
    if (bio == '') this.bios.delete(address)
    else this.bios.set(address, bio)
    if (picture == '') this.pictures.delete(address)
    else this.pictures.set(address, picture)
    Host.emitEvent('profile', [holder.toBytes(), Bytes.fromString(bio), Bytes.fromString(picture)])
  }

  // ---- Trust

  /** Trusts a person (a lowercase address) or a topic ("r/name"), once. */
  @mutateState
  trust(args: TrustArgs): void {
    util.assert(validTarget(args.target), 'not an address or a topic')
    const caller = Context.caller()
    util.assert(args.target != hex(caller), 'cannot trust oneself')
    askIdentity(caller, '_trust', [caller.toBytes(), Bytes.fromString(args.target)], args._gas)
  }

  @mutateState
  _trust(giver: Address, target: string): void {
    util.assert(canTrust(promisedState()), 'not a validated identity')
    const key = target + ':' + hex(giver)
    util.assert(this.trusts.get(key, '') == '', 'already trusted')
    this.trusts.set(key, epochText(Context.epoch()))
    this.counts.set(target, (U64.parseInt(this.counts.get(target, '0')) + 1).toString())
    Host.emitEvent('trust', [giver.toBytes(), Bytes.fromString(target)])
  }

  /** Takes a Trust back. */
  @mutateState
  untrust(args: TrustArgs): void {
    const caller = Context.caller()
    const key = args.target + ':' + hex(caller)
    util.assert(this.trusts.get(key, '') != '', 'not trusted')
    this.trusts.delete(key)
    const count = U64.parseInt(this.counts.get(args.target, '0'))
    if (count <= 1) this.counts.delete(args.target)
    else this.counts.set(args.target, (count - 1).toString())
    Host.emitEvent('untrust', [caller.toBytes(), Bytes.fromString(args.target)])
  }

  // ---- Checks

  private checkFree(name: string): void {
    util.assert(validName(name, 20), 'a-z, 0-9 and _, 3 to 20 characters')
    util.assert(!RESERVED.includes(name), 'reserved name')
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

function validCid(cid: string): bool {
  if (cid.length < 10) return false
  for (let i = 0; i < cid.length; i++) {
    const c = cid.charCodeAt(i)
    if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57))) return false
  }
  return true
}
