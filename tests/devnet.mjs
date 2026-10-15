// node tests/devnet.mjs [CONTRACT]: the contract on the workspace's social devnet (replay/social-devnet: node 1 =
// a Human identity, port 29510; node 2 = an address with no identity, port 29511). Deploys build/release/
// idena-profile.wasm from node 1 unless CONTRACT is given, then runs each case through real transactions and reads
// the storage back. The devnet stays at epoch 0: the rules that wait for later epochs are not reached here.
import fs from 'node:fs'

const W = '/mnt/data/idena/replay'
const nodes = {
  human: {port: 29510, key: fs.readFileSync(`${W}/social-devnet/api.key`, 'utf8').trim()},
  none: {port: 29511, key: fs.readFileSync(`${W}/social-devnet-2/api.key`, 'utf8').trim()},
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rpc(node, method, params = []) {
  const r = await fetch(`http://localhost:${node.port}`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({method, params, id: 1, key: node.key}),
  })
  const {result, error} = await r.json()
  if (error) throw new Error(`${method}: ${error.message}`)
  return result
}

async function receipt(hash) {
  for (let i = 0; i < 120; i += 1) {
    const r = await rpc(nodes.human, 'bcn_txReceipt', [hash])
    if (r) return r
    await sleep(3000)
  }
  throw new Error(`no receipt for ${hash}`)
}

const hexOf = (text) => `0x${Buffer.from(text, 'utf8').toString('hex')}`
let contract = process.argv[2]
const addr = {}
let failures = 0

function check(what, ok, detail = '') {
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`)
}

/** Calls `method` with its JSON argument from `who`; returns {receipt, events, callbackOk, error}. */
async function call(who, method, arg) {
  const node = nodes[who]
  const hash = await rpc(node, 'contract_call', [
    {
      from: addr[who],
      contract,
      method,
      maxFee: '3000',
      args: arg === null ? [] : [{index: 0, format: 'string', value: JSON.stringify(arg)}],
    },
  ])
  const r = await receipt(hash)
  const actions = []
  const walk = (a) => {
    if (!a) return
    actions.push(a)
    ;(a.subActionResults || []).forEach(walk)
  }
  walk(r.actionResult)
  const errors = actions.filter((a) => !a.success).map((a) => `${a.inputAction?.method || a.inputAction?.actionType}: ${a.error}`)
  return {r, events: (r.events || []).map((e) => e.event), errors, ok: r.success && errors.length === 0}
}

async function read(map, key) {
  try {
    return await rpc(nodes.human, 'contract_readMap', [contract, map, hexOf(key), 'string'])
  } catch (e) {
    return null
  }
}

addr.human = (await rpc(nodes.human, 'dna_getCoinbaseAddr')).toLowerCase()
addr.none = (await rpc(nodes.none, 'dna_getCoinbaseAddr')).toLowerCase()
console.log(`human ${addr.human}, no identity ${addr.none}`)

if (!contract) {
  const code = fs.readFileSync(new URL('../build/release/idena-profile.wasm', import.meta.url))
  const estimate = await rpc(nodes.human, 'contract_estimateDeploy', [
    {from: addr.human, code: `0x${code.toString('hex')}`, maxFee: '20000'},
  ])
  console.log(`deploy estimate: ${JSON.stringify({gasUsed: estimate.gasUsed, txFee: estimate.txFee, gasCost: estimate.gasCost, success: estimate.success, error: estimate.error})}`)
  const hash = await rpc(nodes.human, 'contract_deploy', [
    {from: addr.human, code: `0x${code.toString('hex')}`, maxFee: '20000'},
  ])
  const r = await receipt(hash)
  console.log(`deployed ${r.contract} (${code.length} bytes): success ${r.success}, gasUsed ${r.gasUsed}, txFee ${r.txFee}, gasCost ${r.gasCost}`)
  contract = r.contract
}
const fee = await rpc(nodes.human, 'bcn_feePerGas')
console.log(`contract ${contract}; fee per gas ${fee}`)

let c = await call('human', 'claimName', {name: 'Bad Name'})
check('an invalid name is refused', !c.ok, c.errors.join('; '))
c = await call('none', 'claimName', {name: 'nobody_here'})
check('no identity: the claim is refused in the callback', !c.ok && (await read('n:', 'nobody_here')) === null, c.errors.join('; '))
c = await call('human', 'claimName', {name: 'felix_test'})
check('a Human claims a name', c.ok && (await read('n:', 'felix_test')) === addr.human && (await read('a:', addr.human)) === 'felix_test', `events ${c.events}; gasUsed ${c.r.gasUsed}, txFee ${c.r.txFee}, gasCost ${c.r.gasCost}`)
c = await call('human', 'claimName', {name: 'felix_test'})
check('a taken name is refused', !c.ok, c.errors.join('; '))
c = await call('human', 'claimName', {name: 'felix_other'})
check('a second change in the same epoch is refused', !c.ok && (await read('a:', addr.human)) === 'felix_test', c.errors.join('; '))
c = await call('none', '_claimName', null)
check('a callback called directly is refused', !c.ok, c.errors.join('; '))

c = await call('human', 'setProfile', {bio: 'Testing names on the devnet ❤️', picture: 'ipfs://bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy'})
check('a Human sets a bio and a picture', c.ok && (await read('b:', addr.human)) === 'Testing names on the devnet ❤️', `gasUsed ${c.r.gasUsed}, txFee ${c.r.txFee}, gasCost ${c.r.gasCost}`)
c = await call('human', 'setProfile', {bio: 'x'.repeat(161), picture: ''})
check('a bio over 160 characters is refused', !c.ok, c.errors.join('; '))
c = await call('none', 'setProfile', {bio: 'spam', picture: ''})
check('no identity: the profile is refused', !c.ok && (await read('b:', addr.none)) === null, c.errors.join('; '))

c = await call('human', 'trust', {target: addr.none})
check('a Human trusts an address', c.ok && (await read('k:', addr.none)) === '1' && (await read('t:', `${addr.none}:${addr.human}`)) === '0', `events ${c.events}; gasUsed ${c.r.gasUsed}, txFee ${c.r.txFee}, gasCost ${c.r.gasCost}`)
c = await call('human', 'trust', {target: addr.none})
check('a second Trust of the same target is refused', !c.ok && (await read('k:', addr.none)) === '1', c.errors.join('; '))
c = await call('human', 'trust', {target: 'r/idena'})
check('a Human trusts a topic', c.ok && (await read('k:', 'r/idena')) === '1', c.events.join(','))
c = await call('human', 'trust', {target: addr.human})
check('trusting oneself is refused', !c.ok, c.errors.join('; '))
c = await call('human', 'trust', {target: 'r/Bad'})
check('an invalid topic is refused', !c.ok, c.errors.join('; '))
c = await call('none', 'trust', {target: addr.human})
check('no identity: the Trust is refused', !c.ok && (await read('k:', addr.human)) === null, c.errors.join('; '))
const givers = await rpc(nodes.human, 'contract_iterateMap', [contract, `t:${addr.none}:`, null, 'string', 'string', 10])
check('the givers of a target are listed by prefix', givers?.items?.length === 1, JSON.stringify(givers?.items))
c = await call('human', 'untrust', {target: addr.none})
check('untrust takes it back', c.ok && (await read('k:', addr.none)) === null && (await read('t:', `${addr.none}:${addr.human}`)) === null, c.events.join(','))
c = await call('human', 'untrust', {target: addr.none})
check('untrusting twice is refused', !c.ok, c.errors.join('; '))

c = await call('none', 'challengeName', {name: 'felix_test'})
check('a challenge of a validated holder records nothing', c.ok && (await read('c:', `felix_test:${addr.none}`)) === null, c.events.join(','))

c = await call('human', 'dropName', null)
check('the holder drops the name', c.ok && (await read('n:', 'felix_test')) === null && (await read('x:', 'felix_test')) === '2', c.events.join(','))
c = await call('human', 'claimName', {name: 'felix_test'})
check('a dropped name stays blocked', !c.ok, c.errors.join('; '))

console.log(failures === 0 ? 'ALL PASSED' : `${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
