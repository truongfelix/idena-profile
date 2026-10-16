#!/usr/bin/env python3
"""Deploys build/release/idena-profile.wasm from the account of an Idena node reached over its RPC.

    python3 scripts/deploy.py <node RPC URL> <deployer address>

The node signs: its key never leaves it. The script asks the node's API key (hidden), then checks the wasm's sha256,
that the node's account is the deployer given, its balance, and a dry run; it shows the cost and sends only after
"deploy" is typed. It then waits for the block, checks that the contract answers with this code, and saves a record
(no key) in logs/. The contract has no owner: the deployer gets no right over it. No amount is sent (it would stay
in the contract for good).
"""
import getpass
import hashlib
import json
import math
import os
import sys
import time
import urllib.request
from decimal import Decimal

WASM = os.path.join(os.path.dirname(__file__), '..', 'build', 'release', 'idena-profile.wasm')
# The reviewed build (idena-profile b49127a, 2026-10-16).
EXPECTED_SHA256 = '05719792d5386f7f02ec12d333d5cddf5bcfe5f6851d3a312d2647e346cd05aa'
# The max fee: twice the dry run's fee, as the apps send.
MAX_FEE_FACTOR = 2
WAIT_SECONDS = 15 * 60


def fail(text):
    print(f'Stopped: {text}')
    sys.exit(1)


def main():
    if len(sys.argv) != 3:
        fail('usage: python3 scripts/deploy.py <node RPC URL> <deployer address>')
    url, deployer = sys.argv[1], sys.argv[2].lower()
    if not (deployer.startswith('0x') and len(deployer) == 42):
        fail(f'not an address: {deployer}')

    code = open(WASM, 'rb').read()
    sha = hashlib.sha256(code).hexdigest()
    print(f'Contract code: {len(code)} bytes, sha256 {sha}')
    if sha != EXPECTED_SHA256:
        fail(f'this is not the reviewed build (sha256 {EXPECTED_SHA256})')

    key = os.environ.get('IDENA_API_KEY') or getpass.getpass('API key of the node: ')

    def rpc(method, params):
        body = json.dumps({'method': method, 'params': params, 'id': 1, 'key': key}).encode()
        request = urllib.request.Request(url, body, {'Content-Type': 'application/json'})
        answer = json.load(urllib.request.urlopen(request, timeout=120))
        if answer.get('error'):
            raise RuntimeError(f"{method}: {answer['error'].get('message')}")
        return answer.get('result')

    account = str(rpc('dna_getCoinbaseAddr', [])).lower()
    if account != deployer:
        fail(f'the node signs as {account}, not {deployer}')
    syncing = rpc('bcn_syncing', [])
    if syncing.get('syncing'):
        fail(f"the node is syncing ({syncing.get('currentBlock')} of {syncing.get('highestBlock')})")
    balance = Decimal(rpc('dna_getBalance', [deployer])['balance'])
    print(f'Deployer {deployer}: {balance} iDNA, node at block {syncing.get("currentBlock")}')

    nonce = '0x' + os.urandom(8).hex()
    args = {'from': deployer, 'code': '0x' + code.hex(), 'nonce': nonce}
    estimate = rpc('contract_estimateDeploy', [args])
    if not estimate.get('success'):
        fail(f"the dry run failed: {estimate.get('error')}")
    fee = Decimal(estimate['txFee']) + Decimal(estimate['gasCost'])
    max_fee = Decimal(math.ceil(fee * MAX_FEE_FACTOR))
    contract = str(estimate.get('contract') or '').lower()
    print(f"Dry run: {estimate['gasUsed']} gas, fee about {fee:.4f} iDNA (size {Decimal(estimate['txFee']):.4f}, "
          f"gas {Decimal(estimate['gasCost']):.4f}); max fee {max_fee} iDNA")
    if contract:
        print(f'The contract address will be {contract} (nonce {nonce})')
    if balance < max_fee:
        fail(f'the balance does not cover the max fee ({max_fee} iDNA)')

    if input('Type "deploy" to send it, anything else stops: ').strip() != 'deploy':
        fail('nothing sent')
    tx = rpc('contract_deploy', [{**args, 'maxFee': str(max_fee)}])
    print(f'Sent: {tx}. Waiting for its block…')

    receipt = None
    deadline = time.time() + WAIT_SECONDS
    while time.time() < deadline:
        receipt = rpc('bcn_txReceipt', [tx])
        if receipt:
            break
        time.sleep(10)
    if not receipt:
        fail(f'no block holds {tx} after {WAIT_SECONDS // 60} min: look it up later (bcn_txReceipt)')
    contract = str(receipt.get('contract') or contract).lower()
    if not receipt.get('success'):
        fail(f"the deploy failed in its block: {receipt.get('error')}")
    block = rpc('bcn_transaction', [tx]).get('blockHash')

    # The contract answers with this code: a dry-run call it refuses with its own reason.
    probe = rpc('contract_estimateCall', [{
        'from': deployer, 'contract': contract, 'method': 'trust',
        'args': [{'index': 0, 'format': 'string', 'value': json.dumps({'target': 'not a target'})}],
    }])
    answers = 'not an address or a topic' in json.dumps(probe)
    record = {
        'contract': contract, 'tx': tx, 'blockHash': block, 'nonce': nonce, 'deployer': deployer,
        'sha256': sha, 'gasUsed': receipt.get('gasUsed'), 'txFee': receipt.get('txFee'), 'gasCost': receipt.get('gasCost'),
        'time': time.strftime('%Y-%m-%d %H:%M:%S %Z'), 'answers': answers,
    }
    os.makedirs(os.path.join(os.path.dirname(__file__), '..', 'logs'), exist_ok=True)
    path = os.path.join(os.path.dirname(__file__), '..', 'logs', f"deploy-{time.strftime('%Y%m%d-%H%M%S')}.json")
    with open(path, 'w') as f:
        json.dump(record, f, indent=2)
    print(f'Deployed: {contract}' + ('' if answers else ' (WARNING: the check call did not answer as expected)'))
    print(f'Record: {os.path.abspath(path)}')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError) as error:
        fail(str(error))
