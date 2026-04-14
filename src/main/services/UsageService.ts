
interface UsageData {
    currentMonthSpend: number;
    lastResetDate: string; // ISO String
}

interface AnthropicTokenUsage {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

// Claude Opus 4.6 pricing
const MODEL_RATES = {
    INPUT_TOKEN: 0.000015,        // $15.00 / 1M tokens
    CACHED_INPUT_TOKEN: 0.0000015, // $1.50 / 1M tokens (cache read)
    OUTPUT_TOKEN: 0.000075,       // $75.00 / 1M tokens
};

export class UsageService {
    private static instance: UsageService;

    private constructor() { }

    public static getInstance(): UsageService {
        if (!UsageService.instance) {
            UsageService.instance = new UsageService();
        }
        return UsageService.instance;
    }

    private storeUnavailable = false;

    // Helper to dynamically load electron-store (ESM).
    // Returns null when running outside an Electron app context (e.g. dev test scripts);
    // callers must tolerate a null store and skip persistence.
    private async getStore(): Promise<any> {
        if (this.storeUnavailable) return null;
        try {
            const { default: Store } = await import('electron-store');
            return new Store();
        } catch (err) {
            this.storeUnavailable = true;
            console.warn('💰 UsageService: electron-store unavailable, persistence disabled', err);
            return null;
        }
    }

    /**
     * Initializes usage data if not present.
     * Performs monthly reset check on startup.
     */
    public async initialize(): Promise<void> {
        const store = await this.getStore();
        if (!store) return;
        const usage = store.get('usageData') as UsageData;

        if (!usage) {
            const initial: UsageData = {
                currentMonthSpend: 0.00,
                lastResetDate: new Date().toISOString()
            };
            store.set('usageData', initial);
            return;
        }

        await this.checkMonthlyReset();
    }

    /**
     * Resets spending if we have entered a new month relative to lastResetDate.
     */
    public async checkMonthlyReset(): Promise<void> {
        const store = await this.getStore();
        if (!store) return;
        const usage = store.get('usageData') as UsageData;
        if (!usage) return; // Should be handled by initialize

        const lastDate = new Date(usage.lastResetDate);
        const now = new Date();

        // Check if Month or Year is different
        if (lastDate.getMonth() !== now.getMonth() || lastDate.getFullYear() !== now.getFullYear()) {
            console.log('🗓️ Monthly Usage Reset Triggered.');
            const resetData: UsageData = {
                currentMonthSpend: 0.00,
                lastResetDate: now.toISOString()
            };
            store.set('usageData', resetData);
        }
    }

    /**
     * Calculates estimated cost for Vision requests (Pre-flight).
     * Returns cost in Dollars (e.g., 0.0005)
     */
    public calculateVisionCost(width: number, height: number, detail: 'low' | 'high' = 'high'): number {
        let tokens = 0;

        if (detail === 'low') {
            tokens = 85;
        } else {
            // High Detail Logic
            // 1. Maintain aspect ratio, scale to fit within 2048x2048
            let scaledWidth = width;
            let scaledHeight = height;

            if (scaledWidth > 2048 || scaledHeight > 2048) {
                const ratio = Math.min(2048 / scaledWidth, 2048 / scaledHeight);
                scaledWidth = Math.floor(scaledWidth * ratio);
                scaledHeight = Math.floor(scaledHeight * ratio);
            }

            // 2. Scale such that the shortest side is 768px
            const shortestSide = Math.min(scaledWidth, scaledHeight);
            const scaleFactor = 768 / shortestSide;
            scaledWidth = Math.floor(scaledWidth * scaleFactor);
            scaledHeight = Math.floor(scaledHeight * scaleFactor);

            // 3. Count 512x512 tiles needed
            const tilesX = Math.ceil(scaledWidth / 512);
            const tilesY = Math.ceil(scaledHeight / 512);
            const totalTiles = tilesX * tilesY;

            // 4. Formula
            tokens = 85 + (170 * totalTiles);
        }

        return tokens * MODEL_RATES.INPUT_TOKEN;
    }

    /**
     * Adds actual API usage to the accumulator.
     */
    public async incrementUsage(usage: AnthropicTokenUsage): Promise<number> {
        const cached = usage.cache_read_input_tokens || 0;
        const regularInput = Math.max(0, usage.input_tokens - cached);
        const output = usage.output_tokens || 0;

        const cost = (regularInput * MODEL_RATES.INPUT_TOKEN) +
            (cached * MODEL_RATES.CACHED_INPUT_TOKEN) +
            (output * MODEL_RATES.OUTPUT_TOKEN);

        const store = await this.getStore();
        if (!store) {
            console.log(`💰 Usage Added: $${cost.toFixed(6)} (not persisted — no electron context)`);
            return cost;
        }
        const currentData = store.get('usageData') as UsageData;

        // Safety initialization if missing
        const currentSpend = currentData?.currentMonthSpend || 0;
        const lastReset = currentData?.lastResetDate || new Date().toISOString();

        const newSpend = currentSpend + cost;

        store.set('usageData', {
            currentMonthSpend: newSpend,
            lastResetDate: lastReset
        });

        console.log(`💰 Usage Added: $${cost.toFixed(6)} | Total: $${newSpend.toFixed(4)}`);
        return newSpend;
    }

}
