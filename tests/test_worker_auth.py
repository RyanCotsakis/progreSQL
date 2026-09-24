import base64
import hashlib
import hmac

from argon2 import PasswordHasher
from argon2.low_level import Type, hash_secret_raw
from scripts.prepare_worker_auth import convert
import json


def test_existing_argon2_password_and_authenticator_are_preserved():
    password = 'A test password, not a user secret'
    encoded = PasswordHasher().hash(password)
    source = {'auth_username': 'Private', 'auth_password_hash': encoded, 'auth_totp_secret': 'JBSWY3DPEHPK3PXP'}
    converted = convert(source, 'test-pepper')
    params = json.loads(converted['AUTH_PASSWORD_PARAMETERS'])
    salt = base64.b64decode(params['salt'] + '=' * (-len(params['salt']) % 4))
    derived = hash_secret_raw(password.encode(), salt, params['iterations'], params['memorySize'], params['parallelism'], params['hashLength'], Type.ID)
    assert hmac.new(b'test-pepper', derived, hashlib.sha256).hexdigest() == converted['AUTH_PASSWORD_VERIFIER']
    assert converted['AUTH_TOTP_SECRET'] == source['auth_totp_secret']
    assert converted['AUTH_USERNAME'] == source['auth_username']
    assert encoded not in json.dumps(converted)
    assert base64.b64encode(derived).decode().rstrip('=') not in json.dumps(converted)
