/** USB endpoints may briefly disappear during upload. Do not make another open
 * attempt (or publish its outcome) after the user changes the serial endpoint. */
export async function restoreUploadMonitor(
    ownsPort: () => boolean,
    open: () => Promise<void>,
    wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
): Promise<boolean> {
    let lastError: unknown;
    for (const delay of [0, 150, 200, 350, 500]) {
        if (!ownsPort()) return false;
        if (delay) await wait(delay);
        if (!ownsPort()) return false;
        try {
            await open();
            return ownsPort();
        } catch (error) {
            lastError = error;
        }
    }
    if (!ownsPort()) return false;
    throw lastError ?? new Error('串口尚未重新出现');
}
