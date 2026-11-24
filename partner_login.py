"""Log in to Partner TV and install the returned authKey as a GitHub secret.

Run locally: python partner_login.py
Enter the Partner TV account email and password when prompted. The password is
never written to disk. The authKey is encrypted with GitHub's repository public
key and stored as PARTNER_AUTH_KEY.
"""
import base64
import getpass
import json
import os
import subprocess
import sys

import requests

REPO = 'YoavR1/hot-family-epg'
SECRET_NAME = 'PARTNER_AUTH_KEY'
LOGIN_URL = 'https://my.partner.co.il/TV.Services/MyTvSrv.svc/Login/AuthTvContract'
HEADERS = {
    'platform': 'WEB',
    'brand': 'orange',
    'category': 'TV',
    'lang': 'he-il',
    'appName': 'TV',
    'subCategory': 'LOGIN',
    'Content-Type': 'application/json',
    'Origin': 'https://www.partner.co.il',
    'Referer': 'https://www.partner.co.il/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/147.0 Safari/537.36',
}


def find_token(obj):
    if isinstance(obj, dict):
        if isinstance(obj.get('auth'), dict) and obj['auth'].get('token'):
            return obj['auth']['token']
        for value in obj.values():
            token = find_token(value)
            if token:
                return token
    elif isinstance(obj, list):
        for value in obj:
            token = find_token(value)
            if token:
                return token
    return ''


def github_token():
    result = subprocess.run(
        ['git', 'credential', 'fill'],
        input='protocol=https\nhost=github.com\n\n',
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    for line in result.stdout.splitlines():
        if line.startswith('password='):
            return line.split('=', 1)[1]
    raise RuntimeError('GitHub credential helper returned no token')


def install_secret(auth_key):
    from nacl import encoding, public

    token = github_token()
    api = f'https://api.github.com/repos/{REPO}/actions/secrets'
    headers = {
        'Authorization': f'Bearer {token}',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'partner-login',
    }
    key_response = requests.get(f'{api}/public-key', headers=headers, timeout=30)
    if key_response.status_code != 200:
        raise RuntimeError(f'GitHub public-key request failed: {key_response.status_code} {key_response.text[:200]}')
    key_data = key_response.json()
    public_key = public.PublicKey(key_data['key'].encode('utf-8'), encoding.Base64Encoder())
    sealed = public.SealedBox(public_key)
    encrypted = base64.b64encode(sealed.encrypt(auth_key.encode('utf-8'))).decode('ascii')
    payload = {'encrypted_value': encrypted, 'key_id': key_data['key_id']}
    put_response = requests.put(f'{api}/{SECRET_NAME}', headers=headers, json=payload, timeout=30)
    if put_response.status_code not in (201, 204):
        raise RuntimeError(f'GitHub secret update failed: {put_response.status_code} {put_response.text[:300]}')


def main():
    email = os.getenv('PARTNER_EMAIL', '').strip() or input('Partner TV email: ').strip()
    password = os.getenv('PARTNER_PASSWORD', '') or getpass.getpass('Partner TV password: ')
    if not email or not password:
        print('Email and password are required.')
        return 1

    body = {
        'userName': email,
        'password': password,
        '_keys': ['userName', 'password'],
        '_values': [email, password],
    }
    session = requests.Session()
    try:
        response = session.post(LOGIN_URL, headers=HEADERS, json=body, timeout=60)
    except Exception as exc:
        print(f'Login request failed: {exc!r}')
        return 1
    if response.status_code != 200:
        print(f'Login HTTP {response.status_code}: {response.text[:500]}')
        return 1
    try:
        payload = response.json()
    except Exception:
        print(f'Login returned non-JSON: {response.text[:500]}')
        return 1
    if not payload.get('isSuccess'):
        print(f'Login rejected: {payload.get("errorMsg") or payload.get("statusMessage") or payload}')
        return 1

    auth_key = find_token(payload.get('data'))
    if not auth_key:
        print('Login succeeded but no auth.token was present. Response keys:')
        print(json.dumps(payload, ensure_ascii=False, indent=1)[:3000])
        return 1

    print(f'Login succeeded. authKey length: {len(auth_key)}')
    try:
        install_secret(auth_key)
        print(f'GitHub secret {SECRET_NAME} updated in {REPO}.')
        return 0
    except Exception as exc:
        print(f'Could not update the GitHub secret automatically: {exc!r}')
        print('Copy this value manually into GitHub secret PARTNER_AUTH_KEY:')
        print(auth_key)
        return 1


if __name__ == '__main__':
    sys.exit(main())
