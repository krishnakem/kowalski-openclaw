import { safeStorage } from 'electron';

export class SecureKeyManager {
    private static instance: SecureKeyManager;

    private constructor() { }

    public static getInstance(): SecureKeyManager {
        if (!SecureKeyManager.instance) {
            SecureKeyManager.instance = new SecureKeyManager();
        }
        return SecureKeyManager.instance;
    }

    // Helper to dynamically load electron-store (ESM)
    private async getStore(): Promise<any> {
        const { default: Store } = await import('electron-store');
        return new Store();
    }

    /**
     * Encrypts and saves the API key to disk.
     */
    public async setKey(apiKey: string): Promise<boolean> {
        if (!safeStorage.isEncryptionAvailable()) {
            console.error('SafeStorage encryption is not available.');
            return false;
        }
        try {
            const buffer = safeStorage.encryptString(apiKey);
            const store = await this.getStore();
            store.set('secure.anthropicApiKey', buffer.toString('hex'));
            return true;
        } catch (error) {
            console.error('Failed to encrypt API key:', error);
            return false;
        }
    }

    /**
     * Retrieves and decrypts the API key.
     * Returns null if missing or decryption fails.
     */
    public async getKey(): Promise<string | null> {
        if (!safeStorage.isEncryptionAvailable()) return null;

        try {
            const store = await this.getStore();
            const hex = store.get('secure.anthropicApiKey') as string;
            if (!hex) return null;

            const buffer = Buffer.from(hex, 'hex');
            return safeStorage.decryptString(buffer);
        } catch (error) {
            // Graceful Failure: If OS keychain is locked or changed, treat as missing.
            console.error('Decryption failed, treating key as missing:', error);
            return null;
        }
    }

    /**
     * Checks the status of the key without exposing it.
     */
    public async getKeyStatus(): Promise<'locked' | 'secured' | 'missing'> {
        if (!safeStorage.isEncryptionAvailable()) {
            return 'locked';
        }

        try {
            const store = await this.getStore();
            const hex = store.get('secure.anthropicApiKey') as string;
            if (!hex) {
                return 'missing';
            }
            return 'secured';
        } catch (error) {
            console.error('Error checking key status:', error);
            return 'missing';
        }
    }
}
