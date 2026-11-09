import type { Pairing } from "./credentials.ts";

const paired = (pairing: Pairing) => pairing.desktop !== null || pairing.computer !== null;

/**
 * 读这个地址的凭据。默认地址换过、新地址下还没有凭据时，旧地址下的那份是同一个 Pupu 的：
 * 复制到新地址下再用，旧的那份留着，回退旧版也还能用。只认默认地址，开发时连别处不搬。
 */
export async function readWithLegacy(
  origin: string,
  defaultUrl: string,
  legacy: readonly string[],
  read: (origin: string) => Promise<Pairing>,
  write: (origin: string, pairing: Pairing) => Promise<void>
): Promise<{ readonly pairing: Pairing; readonly from: string | null }> {
  const current = await read(origin);
  if (paired(current) || origin !== defaultUrl) return { pairing: current, from: null };
  for (const old of legacy) {
    const pairing = await read(old);
    if (!paired(pairing)) continue;
    await write(origin, pairing);
    return { pairing, from: old };
  }
  return { pairing: current, from: null };
}
