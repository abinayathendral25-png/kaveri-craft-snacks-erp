// Exact integer-paisa and milli-unit arithmetic helpers (zero floating-point drift).

const UNIT_MULTIPLIER_TO_MILLI = {
  // Mass (base_unit = 'g')
  g: 1000n,
  kg: 1000000n,
  // Volume (base_unit = 'ml')
  ml: 1000n,
  L: 1000000n,
  l: 1000000n,
  // Count (base_unit = 'piece')
  piece: 1000n,
  pieces: 1000n,
  pcs: 1000n,
  // Finished goods (base_unit = 'packet')
  packet: 1000n,
  packets: 1000n,
};

const UNIT_FAMILY = {
  g: 'g',
  kg: 'g',
  ml: 'ml',
  L: 'ml',
  l: 'ml',
  piece: 'piece',
  pieces: 'piece',
  pcs: 'piece',
  packet: 'packet',
  packets: 'packet',
  carton: 'packet',
  cartons: 'packet',
};

/**
 * Parse a decimal number or numeric string into integer scaled by factor (BigInt).
 */
function parseScaledBigInt(value, factorBigInt) {
  if (value === null || value === undefined || value === '') {
    throw new Error('Quantity or amount cannot be empty');
  }
  const str = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    throw new Error(`Invalid numeric value: "${value}"`);
  }
  const negative = str.startsWith('-');
  const unsigned = negative ? str.slice(1) : str;
  const [intPart, fracPart = ''] = unsigned.split('.');
  const scaleDigits = factorBigInt.toString().length - 1;
  const paddedFrac = (fracPart + '0'.repeat(scaleDigits + 1)).slice(0, scaleDigits);
  const roundDigit = Number((fracPart + '0'.repeat(scaleDigits + 1))[scaleDigits] || '0');
  let result = BigInt(intPart) * factorBigInt + BigInt(paddedFrac || '0');
  if (roundDigit >= 5) result += 1n;
  return negative ? -result : result;
}

/**
 * Convert Rupees (number/string) to integer paisa.
 */
function rupeesToPaisa(rupees) {
  return Number(parseScaledBigInt(rupees, 100n));
}

/**
 * Format integer paisa to string like "7875.00".
 */
function formatPaisa(paisa) {
  const n = Number(paisa || 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(Math.round(n));
  const r = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, '0');
  return `${sign}${r}.${p}`;
}

/**
 * Convert a user-entered quantity and unit into canonical integer milli-base-units.
 */
function toMilliBase(qty, unit, item) {
  const cleanUnit = String(unit || item.display_unit).trim();
  const family = UNIT_FAMILY[cleanUnit];
  if (!family || family !== item.base_unit) {
    throw new Error(
      `Unit "${cleanUnit}" is not compatible with item "${item.name}" (base unit: ${item.base_unit})`
    );
  }
  if (cleanUnit === 'carton' || cleanUnit === 'cartons') {
    const packetsPerCarton = BigInt(item.packets_per_carton || 20);
    return Number(parseScaledBigInt(qty, 1000n * packetsPerCarton));
  }
  const mult = UNIT_MULTIPLIER_TO_MILLI[cleanUnit];
  return Number(parseScaledBigInt(qty, mult));
}

/**
 * Convert canonical milli-base-units back to numeric display units (for JSON/UI).
 */
function milliToDisplay(qtyMilli, displayFactorMilli) {
  return Number((Number(qtyMilli || 0) / Number(displayFactorMilli || 1000)).toFixed(3));
}

/**
 * Compute exact line cost in paisa using BigInt half-up rounding.
 */
function computeCostPaisa(qtyMilli, ratePaisaPerDisplay, displayFactorMilli) {
  const q = BigInt(Math.round(qtyMilli));
  const r = BigInt(Math.round(ratePaisaPerDisplay));
  const f = BigInt(Math.round(displayFactorMilli));
  if (f <= 0n) throw new Error('Invalid displayFactorMilli');
  const prod = q * r;
  if (prod >= 0n) {
    return Number((prod + f / 2n) / f);
  }
  return -Number((-prod + f / 2n) / f);
}

/**
 * Compute GST breakdown in integer paisa.
 */
function computeGstLine({ qtyPackets, unitPricePaisa, gstRateBps, isInterstate }) {
  const qty = BigInt(Math.round(qtyPackets));
  const price = BigInt(Math.round(unitPricePaisa));
  const taxable = qty * price;
  const rateBps = BigInt(Math.round(gstRateBps));

  let cgst = 0n;
  let sgst = 0n;
  let igst = 0n;

  if (isInterstate) {
    igst = (taxable * rateBps + 5000n) / 10000n;
  } else {
    const halfBps = rateBps / 2n;
    const otherHalfBps = rateBps - halfBps;
    cgst = (taxable * halfBps + 5000n) / 10000n;
    sgst = (taxable * otherHalfBps + 5000n) / 10000n;
  }

  return {
    taxablePaisa: Number(taxable),
    cgstPaisa: Number(cgst),
    sgstPaisa: Number(sgst),
    igstPaisa: Number(igst),
    totalPaisa: Number(taxable + cgst + sgst + igst),
  };
}

/**
 * Compute variance in basis points (100 bps = 1%).
 */
function computeVarianceBps(actual, planned) {
  if (!planned || planned === 0) return 0;
  return Math.round(((actual - planned) * 10000) / planned);
}

function formatBpsPercent(bps) {
  const sign = bps > 0 ? '+' : '';
  return `${sign}${(bps / 100).toFixed(2)}%`;
}

module.exports = {
  rupeesToPaisa,
  formatPaisa,
  toMilliBase,
  milliToDisplay,
  computeCostPaisa,
  computeGstLine,
  computeVarianceBps,
  formatBpsPercent,
};
