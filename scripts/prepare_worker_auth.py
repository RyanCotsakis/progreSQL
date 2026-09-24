"""Preserve the existing password and TOTP enrollment without exposing secrets.

The browser computes the existing Argon2id derivation. The Worker verifies an
HMAC-peppered verifier using a secret key, then independently validates TOTP.
The original Argon2 digest is not published or stored in the new verifier.
"""
import base64
import hashlib
import hmac
import json
from pathlib import Path
import secrets
import tomllib

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / '.env.auth-upload.json'


def convert(source: dict, pepper: str) -> dict[str, str]:
    parts = source['auth_password_hash'].split('$')
    if len(parts) != 6 or parts[1:3] != ['argon2id', 'v=19']:
        raise ValueError('Expected an Argon2id v19 password hash.')
    settings = dict(item.split('=') for item in parts[3].split(','))
    digest = base64.b64decode(parts[5] + '=' * (-len(parts[5]) % 4))
    parameters = {'algorithm': 'argon2id', 'salt': parts[4], 'iterations': int(settings['t']),
                  'memorySize': int(settings['m']), 'parallelism': int(settings['p']), 'hashLength': len(digest)}
    return {
        'AUTH_USERNAME': source['auth_username'],
        'AUTH_PASSWORD_PARAMETERS': json.dumps(parameters, separators=(',', ':')),
        'AUTH_PASSWORD_VERIFIER': hmac.new(pepper.encode(), digest, hashlib.sha256).hexdigest(),
        'AUTH_PEPPER': pepper,
        'AUTH_TOTP_SECRET': source['auth_totp_secret'],
    }


def main():
    source = tomllib.loads((ROOT / '.streamlit/secrets.toml').read_text(encoding='utf-8'))
    # Reuse the pepper on repeated runs so existing sessions aren't needlessly revoked.
    pepper = json.loads(OUTPUT.read_text())['AUTH_PEPPER'] if OUTPUT.exists() else secrets.token_urlsafe(48)
    values = convert(source, pepper)
    OUTPUT.write_text(json.dumps(values, indent=2) + '\n', encoding='utf-8')
    (ROOT / '.dev.vars').write_text('\n'.join(f'{key}={json.dumps(value)}' for key, value in values.items()) + '\n', encoding='utf-8')
    print('Prepared ignored Worker secret files. Existing username, password, and TOTP enrollment preserved.')


if __name__ == '__main__':
    main()
