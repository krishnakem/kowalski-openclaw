/**
 * InputForwarder — dispatches renderer input events to the headless browser via CDP.
 *
 * Used during the login screencast: the user interacts with the Kowalski canvas,
 * and this module forwards those mouse/keyboard/scroll events to the headless
 * Chromium page so Instagram sees real user input.
 */
import type { CDPSession } from 'playwright';

// CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8
export interface InputEventPayload {
    // Mouse
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel'
        // Keyboard (keyDown with text IS the character insert — no separate 'char' event)
        | 'keyDown' | 'keyUp'
        // Clipboard
        | 'paste';
    x?: number;
    y?: number;
    button?: 'none' | 'left' | 'middle' | 'right';
    buttons?: number; // bitmask: left=1, right=2, middle=4
    clickCount?: number;
    deltaX?: number;
    deltaY?: number;
    key?: string;
    code?: string;
    modifiers?: number;
    text?: string;
}

export class InputForwarder {
    private cdp: CDPSession | null = null;

    attach(cdp: CDPSession): void {
        this.cdp = cdp;
    }

    detach(): void {
        this.cdp = null;
    }

    async dispatch(event: InputEventPayload): Promise<void> {
        if (!this.cdp) return;

        try {
            switch (event.type) {
                // --- Clipboard ---
                case 'paste':
                    if (event.text) {
                        await this.cdp.send('Input.insertText', { text: event.text });
                    }
                    break;

                // --- Mouse wheel ---
                case 'mouseWheel':
                    await this.cdp.send('Input.dispatchMouseEvent', {
                        type: 'mouseWheel',
                        x: event.x ?? 0,
                        y: event.y ?? 0,
                        deltaX: event.deltaX ?? 0,
                        deltaY: event.deltaY ?? 0,
                    });
                    break;

                // --- Mouse buttons + movement ---
                case 'mousePressed':
                case 'mouseReleased':
                case 'mouseMoved':
                    await this.cdp.send('Input.dispatchMouseEvent', {
                        type: event.type,
                        x: event.x ?? 0,
                        y: event.y ?? 0,
                        button: event.button || 'none',
                        buttons: event.buttons ?? 0,
                        clickCount: event.clickCount ?? (event.type === 'mousePressed' ? 1 : 0),
                        modifiers: event.modifiers ?? 0,
                    });
                    break;

                // --- Keyboard ---
                // keyDown with text IS the character insert — no separate char event.
                case 'keyDown': {
                    const text = event.text ?? '';
                    await this.cdp.send('Input.dispatchKeyEvent', {
                        type: 'keyDown',
                        key: event.key ?? '',
                        code: event.code ?? '',
                        text,
                        unmodifiedText: text,
                        modifiers: event.modifiers ?? 0,
                        windowsVirtualKeyCode: codeToVirtualKeyCode(event.code ?? '', event.key ?? ''),
                    });
                    break;
                }

                case 'keyUp':
                    await this.cdp.send('Input.dispatchKeyEvent', {
                        type: 'keyUp',
                        key: event.key ?? '',
                        code: event.code ?? '',
                        modifiers: event.modifiers ?? 0,
                    });
                    break;
            }
        } catch {
            // CDP session may be closed — swallow silently
        }
    }
}

/**
 * Map a physical key code (e.code) to a Windows virtual key code.
 * Using e.code avoids collisions like '.' (charCode 46 = VK_DELETE).
 * Falls back to the key name for non-printable keys.
 */
function codeToVirtualKeyCode(code: string, key: string): number {
    // Physical key code → VK mapping
    const codeMap: Record<string, number> = {
        // Letters (KeyA=65 .. KeyZ=90)
        KeyA: 65, KeyB: 66, KeyC: 67, KeyD: 68, KeyE: 69, KeyF: 70,
        KeyG: 71, KeyH: 72, KeyI: 73, KeyJ: 74, KeyK: 75, KeyL: 76,
        KeyM: 77, KeyN: 78, KeyO: 79, KeyP: 80, KeyQ: 81, KeyR: 82,
        KeyS: 83, KeyT: 84, KeyU: 85, KeyV: 86, KeyW: 87, KeyX: 88,
        KeyY: 89, KeyZ: 90,
        // Digits
        Digit0: 48, Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52,
        Digit5: 53, Digit6: 54, Digit7: 55, Digit8: 56, Digit9: 57,
        // Punctuation / OEM keys
        Period: 190, Comma: 188, Slash: 191, Semicolon: 186, Quote: 222,
        BracketLeft: 219, BracketRight: 221, Backslash: 220,
        Minus: 189, Equal: 187, Backquote: 192,
        // Whitespace / editing
        Space: 32, Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27,
        // Navigation
        ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
        Home: 36, End: 35, PageUp: 33, PageDown: 34,
        // Modifiers
        ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17,
        AltLeft: 18, AltRight: 18, MetaLeft: 91, MetaRight: 93,
    };
    if (codeMap[code] !== undefined) return codeMap[code];

    // Fallback for non-printable keys identified by key name
    const keyMap: Record<string, number> = {
        Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
        Shift: 16, Control: 17, Alt: 18, Meta: 91,
    };
    if (keyMap[key] !== undefined) return keyMap[key];

    return 0;
}
