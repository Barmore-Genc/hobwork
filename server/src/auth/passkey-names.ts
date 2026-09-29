// Password managers and platform authenticators by AAGUID, from
// https://github.com/passkeydeveloper/passkey-authenticator-aaguids. Only
// those that report one: the rest send zeros.
const PROVIDERS: Record<string, string> = {
  'fbfc3007-154e-4ecc-8c0b-6e020557d7bd': 'Apple Passwords',
  'dd4ec289-e01d-41c9-bb89-70fa845d4bf2': 'iCloud Keychain (Managed)',
  'ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4': 'Google Password Manager',
  'adce0002-35bc-c60a-648b-0b25f1f05503': 'Chrome on Mac',
  'b5397666-4885-aa6b-cebf-e52262a439a2': 'Chromium Browser',
  '771b48fd-d3d4-4f74-9232-fc157ab0507a': 'Edge on Mac',
  '08987058-cadc-4b81-b6e1-30de50dcbe96': 'Windows Hello',
  '9ddd1817-af5a-4672-a2b9-3e3dd95000a9': 'Windows Hello',
  '6028b017-b1d4-4c02-b4b3-afcdafc96bb2': 'Windows Hello',
  'bada5566-a7aa-401f-bd96-45619a55120d': '1Password',
  'd548826e-79b4-db40-a3d8-11116f7e8349': 'Bitwarden',
  '531126d6-e717-415c-9320-3d9aa6981239': 'Dashlane',
  '50726f74-6f6e-5061-7373-50726f746f6e': 'Proton Pass',
  'fdb141b2-5d84-443e-8a35-4698c205a502': 'KeePassXC',
  'eaecdef2-1c31-5634-8639-f1cbd9c00a08': 'KeePassDX',
  'b84e4048-15dc-4dd0-8640-f4f60813c8af': 'NordPass',
  '0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6': 'Keeper',
  'f3809540-7f14-49c1-a8b3-8f813b225541': 'Enpass',
  '53414d53-554e-4700-0000-000000000000': 'Samsung Pass',
}

export const MAX_PASSKEY_NAME = 64

export function passkeyProvider(aaguid: string): string | null {
  return PROVIDERS[aaguid.toLowerCase()] ?? null
}

function clean(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_PASSKEY_NAME) : null
}

// The name a person gave, else what keeps the passkey, else the device the
// browser runs on.
export function passkeyName(options: { name?: unknown; aaguid: string; device?: unknown }): string {
  return clean(options.name) ?? passkeyProvider(options.aaguid) ?? clean(options.device) ?? 'Passkey'
}
