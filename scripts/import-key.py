#!/usr/bin/env python3
"""Gives an Idena node an account's key from its export (the encrypted key of app.idena.io, the desktop or the phone).

    python3 scripts/import-key.py <node RPC URL> <node api.key file> <account address>

Asks the exported key and its password at hidden prompts: neither is written to a file or shown. The node decrypts
the key and saves it as its node key (dna_importKey; its old key is kept as a backup file in its keystore folder);
the node uses it after a restart. The node answers only whether the import worked: the address is checked after
the restart (dna_getCoinbaseAddr).
"""
import getpass
import json
import sys
import urllib.request


def main():
    if len(sys.argv) != 4:
        sys.exit('usage: python3 scripts/import-key.py <node RPC URL> <node api.key file> <account address>')
    url, key_file, address = sys.argv[1], sys.argv[2], sys.argv[3].lower()
    api_key = open(key_file).read().strip()
    exported = getpass.getpass('Exported key (hidden): ').strip()
    password = getpass.getpass('Its password (hidden): ')
    body = json.dumps({
        'method': 'dna_importKey', 'params': [{'key': exported, 'password': password}], 'id': 1, 'key': api_key,
    }).encode()
    request = urllib.request.Request(url, body, {'Content-Type': 'application/json'})
    answer = json.load(urllib.request.urlopen(request, timeout=60))
    if answer.get('error'):
        sys.exit(f"Not imported: {answer['error'].get('message')}")
    print(f'Imported. Restart the node, then check that it signs as {address}.')


if __name__ == '__main__':
    main()
