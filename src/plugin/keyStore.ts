import { Entry } from '@napi-rs/keyring';

const SERVICE = 'kowalski-openclaw';
const ACCOUNT = 'anthropic-api-key';

function entry(): Entry {
    return new Entry(SERVICE, ACCOUNT);
}

export const keyStore = {
    get(): string | null {
        try {
            return entry().getPassword();
        } catch {
            return null;
        }
    },

    set(key: string): void {
        try {
            entry().setPassword(key);
        } catch {
            throw new Error(
                'OS keychain is unavailable, which is common on headless servers or minimal VMs. Set the ANTHROPIC_API_KEY env var instead.'
            );
        }
    },

    clear(): void {
        try {
            entry().deletePassword();
        } catch {
            // Idempotent: missing entries and unavailable keychains are both
            // treated as already clear.
        }
    },
};
