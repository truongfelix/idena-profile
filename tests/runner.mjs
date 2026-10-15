// node tests/runner.mjs: the contract's rules over epochs and identity states, on idena-contract-runner (a chain in
// memory running idena-go's contract VM, localhost:3333) built against the workspace's idena-go with two test calls
// added: chain_setEpoch (moves the epoch, no ceremony) and chain_newAccount (an unlocked key, to act as another
// identity). Each case is real transactions in generated blocks; the storage is read back after each.
import fs from 'node:fs'

const URL_ = process.env.RUNNER_URL ?? 'http://localhost:3333'
const S = {Undefined: 0, Invite: 1, Candidate: 2, Verified: 3, Suspended: 4, Killed: 5, Zombie: 6, Newbie: 7, Human: 8}
const stateName = Object.fromEntries(Object.entries(S).map(([k, v]) => [v, k]))

async function rpc(method, params = []) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({method, params, id: 1, key: ''}),
  })
  const {result, error} = await r.json()
  if (error) throw new Error(`${method}: ${error.message}`)
  return result
}
const hexOf = (text) => `0x${Buffer.from(text, 'utf8').toString('hex')}`
const block = () => rpc('chain_generateBlocks', [1])

let failures = 0
let cases = 0
function check(what, ok, detail = '') {
  cases += 1
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `  [${detail}]` : ''}`)
}

let epoch = 0
async function setEpoch(e) {
  await rpc('chain_setEpoch', [e])
  await block()
  epoch = e
}

async function account(state) {
  const address = (await rpc('chain_newAccount')).toLowerCase()
  await rpc('chain_addBalance', [address, '100000'])
  if (state !== undefined) await rpc('chain_setIdentity', [address, state])
  await block()
  return address
}

/** A state change, as a validation makes it: with a new epoch (the contract reads states once per epoch). */
async function setState(address, state) {
  await rpc('chain_setIdentity', [address, state])
  await setEpoch(epoch + 1)
}

/** A state change in the middle of an epoch (a termination). */
async function setStateNow(address, state) {
  await rpc('chain_setIdentity', [address, state])
  await block()
}

let contract
/** A call from `from`; {ok, errors, events, receipt}: ok only when the call and every callback succeeded. */
async function call(from, method, arg = null) {
  const hash = await rpc('contract_call', [
    {
      from,
      contract,
      method,
      maxFee: '3000',
      args: arg === null ? [] : [{index: 0, format: 'string', value: JSON.stringify(arg)}],
    },
  ])
  await block()
  const r = await rpc('chain_txReceipt', [hash])
  const actions = []
  const walk = (a) => {
    if (!a) return
    actions.push(a)
    ;(a.subActionResults || []).forEach(walk)
  }
  walk(r.actionResult)
  const errors = actions.filter((a) => !a.success).map((a) => `${a.inputAction?.method || 'promise'}: ${a.error}`)
  if (!r.success && r.error) errors.push(r.error)
  return {ok: r.success && errors.length === 0, errors, events: (r.events || []).map((e) => e.event), receipt: r}
}

async function read(map, key) {
  try {
    return await rpc('contract_readMap', [contract, map, hexOf(key), 'string'])
  } catch {
    return null
  }
}

// ---- Deploy
const god = (await rpc('chain_god')).toLowerCase()
const code = fs.readFileSync(new URL('../build/release/idena-profile.wasm', import.meta.url))
const deployHash = await rpc('contract_deploy', [{from: god, code: `0x${code.toString('hex')}`, maxFee: '9000'}])
await block()
contract = (await rpc('chain_txReceipt', [deployHash])).contract
console.log(`contract ${contract} (${code.length} bytes)`)

// ---- 1. Who may do what, for every identity state
console.log('\n== 1. Every identity state: claim a name, set a profile, give Trust')
const target = await account(S.Human)
for (const [name, state] of Object.entries(S)) {
  const who = await account(state)
  const handle = `state_${name.toLowerCase()}`
  const claim = await call(who, 'claimName', {name: handle})
  const holds = (await read('n:', handle)) === who
  const mayHold = [S.Newbie, S.Verified, S.Human].includes(state)
  check(`${name}: claim a name ${mayHold ? 'allowed' : 'refused'}`, holds === mayHold && claim.ok === mayHold, claim.errors.join('; '))
  const profile = await call(who, 'setProfile', {bio: `I am ${name}`, picture: ''})
  const hasBio = (await read('b:', who)) === `I am ${name}`
  check(`${name}: set a profile ${mayHold ? 'allowed' : 'refused'}`, hasBio === mayHold, profile.errors.join('; '))
  const before = Number((await read('k:', target)) ?? 0)
  const trust = await call(who, 'trust', {target})
  const after = Number((await read('k:', target)) ?? 0)
  const mayTrust = mayHold || [S.Suspended, S.Zombie].includes(state)
  check(`${name}: give Trust ${mayTrust ? 'allowed' : 'refused'}`, (after === before + 1) === mayTrust, trust.errors.join('; '))
}

// ---- 2. Renaming over epochs
console.log('\n== 2. Renaming: once per epoch; the old name blocked for 2 epochs')
const alice = await account(S.Human)
const bob = await account(S.Verified)
await setEpoch(10)
check('epoch 10: Alice claims "alice"', (await call(alice, 'claimName', {name: 'alice'})).ok && (await read('n:', 'alice')) === alice)
let c = await call(alice, 'claimName', {name: 'alice_two'})
check('epoch 10: a rename in the same epoch is refused', !c.ok && (await read('a:', alice)) === 'alice', c.errors.join('; '))
await setEpoch(11)
c = await call(alice, 'claimName', {name: 'alice_two'})
check(
  'epoch 11: Alice renames to "alice_two"; both maps follow',
  c.ok && (await read('a:', alice)) === 'alice_two' && (await read('n:', 'alice_two')) === alice && (await read('n:', 'alice')) === null,
  c.errors.join('; ')
)
check('"alice" is blocked until epoch 13', (await read('x:', 'alice')) === '13')
c = await call(bob, 'claimName', {name: 'alice'})
check('epoch 11: Bob cannot take "alice"', !c.ok, c.errors.join('; '))
await setEpoch(12)
c = await call(bob, 'claimName', {name: 'alice'})
check('epoch 12: still blocked', !c.ok, c.errors.join('; '))
await setEpoch(13)
c = await call(bob, 'claimName', {name: 'alice'})
check('epoch 13: Bob takes "alice"', c.ok && (await read('n:', 'alice')) === bob, c.errors.join('; '))
c = await call(alice, 'claimName', {name: 'alice_three'})
check('epoch 13: Alice may rename again (one per epoch, not one ever)', c.ok && (await read('a:', alice)) === 'alice_three', c.errors.join('; '))

// ---- 3. Dropping
console.log('\n== 3. Dropping a name')
c = await call(alice, 'dropName')
check('Alice drops "alice_three": no name left', c.ok && (await read('a:', alice)) === null && (await read('n:', 'alice_three')) === null, c.errors.join('; '))
c = await call(alice, 'dropName')
check('dropping with no name is refused', !c.ok, c.errors.join('; '))
c = await call(alice, 'claimName', {name: 'alice_three'})
check('epoch 13: the dropped name is blocked for its holder too', !c.ok, c.errors.join('; '))
await setEpoch(15)
c = await call(alice, 'claimName', {name: 'alice_three'})
check('epoch 15: Alice claims it again', c.ok && (await read('a:', alice)) === 'alice_three', c.errors.join('; '))

// ---- 4. Freeing the name of a holder who stopped validating
console.log('\n== 4. Challenge and release')
const dave = await account(S.Newbie)
for (const lost of [S.Zombie, S.Suspended, S.Killed, S.Undefined]) {
  const label = stateName[lost]
  const holder = await account(S.Human)
  const handle = `held_${label.toLowerCase()}`
  await call(holder, 'claimName', {name: handle})
  await setEpoch(epoch + 1)
  c = await call(dave, 'challengeName', {name: handle})
  check(`${label}: a challenge of a validated holder records nothing`, c.ok && (await read('c:', handle)) === null, c.errors.join('; '))
  await setState(holder, lost)
  const start = epoch
  c = await call(dave, 'challengeName', {name: handle})
  check(`${label}: the holder is ${label}: the challenge is recorded at epoch ${start}`, (await read('c:', handle)) === String(start), c.errors.join('; '))
  await setEpoch(start + 1)
  await call(dave, 'challengeName', {name: handle})
  check(`${label}: a second challenge keeps the first epoch`, (await read('c:', handle)) === String(start))
  c = await call(dave, 'releaseName', {name: handle})
  check(`${label}: epoch ${start + 1}: release refused, the grace is not over`, !c.ok && (await read('n:', handle)) === holder, c.errors.join('; '))
  await setEpoch(start + 2)
  c = await call(dave, 'releaseName', {name: handle})
  check(
    `${label}: epoch ${start + 2}: released; the name and the holder's link are gone`,
    c.ok && (await read('n:', handle)) === null && (await read('a:', holder)) === null && (await read('c:', handle)) === null,
    c.errors.join('; ')
  )
  if (lost === S.Zombie) {
    c = await call(dave, 'claimName', {name: handle})
    check(`${label}: anyone validated may claim the freed name (no block after a release)`, c.ok && (await read('n:', handle)) === dave, c.errors.join('; '))
  }
}

console.log('\n== 5. A holder who validates again keeps the name')
const erin = await account(S.Verified)
await call(erin, 'claimName', {name: 'erin'})
await setState(erin, S.Suspended)
await call(dave, 'challengeName', {name: 'erin'})
const since = epoch
check('Erin is Suspended: challenged', (await read('c:', 'erin')) === String(since))
await setState(erin, S.Verified)
await setEpoch(since + 2)
c = await call(dave, 'releaseName', {name: 'erin'})
check('Erin validated again: the release keeps her name and clears the challenge', (await read('n:', 'erin')) === erin && (await read('c:', 'erin')) === null, c.errors.join('; '))
c = await call(dave, 'releaseName', {name: 'erin'})
check('a second release is refused: nothing challenged', !c.ok, c.errors.join('; '))
await setState(erin, S.Suspended)
await call(dave, 'challengeName', {name: 'erin'})
const again = epoch
await setState(erin, S.Verified)
await call(dave, 'challengeName', {name: 'erin'})
check('a challenge while she is validated again clears it at once', (await read('c:', 'erin')) === null)
check('(the challenge started at epoch ' + again + ' is gone)', (await read('n:', 'erin')) === erin)

c = await call(dave, 'challengeName', {name: 'nobody_has_it'})
check('challenging a name nobody holds is refused', !c.ok, c.errors.join('; '))

// ---- 6. Trust when the giver changes state
console.log('\n== 6. Trust over a giver\'s life')
const giver = await account(S.Human)
const person = await account(S.Human)
await call(giver, 'trust', {target: person})
await call(giver, 'trust', {target: 'r/idena'})
check('a Human trusts a person and a topic', (await read('k:', person)) === '1' && (await read('t:', `${person}:${giver}`)) === String(epoch))
await setState(giver, S.Killed)
check('the giver is Killed: the Trust stays stored (the apps count only givers still validated)', (await read('k:', person)) === '1')
c = await call(giver, 'untrust', {target: person})
check('a Killed giver can still take a Trust back', c.ok && (await read('k:', person)) === null, c.errors.join('; '))
c = await call(giver, 'trust', {target: person})
check('a Killed giver cannot trust again', !c.ok && (await read('k:', person)) === null, c.errors.join('; '))
await setState(giver, S.Zombie)
c = await call(giver, 'trust', {target: person})
check('back as Zombie: trusting again is allowed', c.ok && (await read('k:', person)) === '1', c.errors.join('; '))
const second = await account(S.Newbie)
await call(second, 'trust', {target: person})
check('a second giver: the count is 2', (await read('k:', person)) === '2')
await call(giver, 'untrust', {target: person})
check('one untrusts: the count is 1, the other Trust stays', (await read('k:', person)) === '1' && (await read('t:', `${person}:${second}`)) !== null)

// ---- 7. The identity state read once per epoch
console.log('\n== 7. The identity state read once per epoch')
await setEpoch(epoch + 1)
const cached = await account(S.Human)
const t1 = await account(S.Human)
const t2 = await account(S.Human)
const t3 = await account(S.Human)
const first = await call(cached, 'trust', {target: t1})
const laterCall = await call(cached, 'trust', {target: t2})
const gas = (r) => Number(r.receipt.gasUsed)
check(
  `the second call in an epoch asks no identity: ${gas(laterCall)} gas against ${gas(first)}`,
  first.ok && laterCall.ok && gas(laterCall) < gas(first) * 0.6 && (await read('i:', cached)) === `${epoch}:${S.Human}`,
  `${first.errors} ${laterCall.errors}`
)
await setStateNow(cached, S.Killed)
c = await call(cached, 'trust', {target: t3})
check('terminated in the middle of the epoch: its state read earlier in the epoch still counts', c.ok, c.errors.join('; '))
await call(cached, 'untrust', {target: t3})
await setEpoch(epoch + 1)
c = await call(cached, 'trust', {target: t3})
check('the next epoch reads it again: refused', !c.ok && (await read('k:', t3)) === null, c.errors.join('; '))
const refused = await account(S.Candidate)
c = await call(refused, 'trust', {target: t1})
check('a refused call keeps nothing: the next one asks again', !c.ok && (await read('i:', refused)) === null, c.errors.join('; '))
const holderC = await account(S.Human)
await call(holderC, 'claimName', {name: 'cache_holder'})
c = await call(dave, 'challengeName', {name: 'cache_holder'})
check('a challenge uses the holder state read in this epoch', c.ok && (await read('c:', 'cache_holder')) === null, c.errors.join('; '))
const costs = {first: gas(first), again: gas(laterCall)}
console.log(`  gas: first call of an epoch ${costs.first}, later calls ${costs.again}`)

console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`} (${cases} checks)`)
process.exitCode = failures === 0 ? 0 : 1
