// Pure zero-dependency PDF 1.4 generator for GST Tax Invoices and Monthly Audit Reports.
const { formatPaisa } = require('./math');

function pdfEscape(str) {
  return String(str ?? '')
    .replace(/[^\x20-\x7E]/g, (ch) => (ch === '₹' ? 'Rs.' : ' '))
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildPdfDocument(pagesContent) {
  const objects = [];
  const addObj = (body) => {
    objects.push(body);
    return objects.length;
  };

  const fontRegularId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBoldId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const pageIds = [];
  const pagesPlaceholderId = addObj(''); // filled after pages are created

  for (const streamStr of pagesContent) {
    const streamBytes = Buffer.byteLength(streamStr, 'latin1');
    const contentId = addObj(`<< /Length ${streamBytes} >>\nstream\n${streamStr}\nendstream`);
    const pageId = addObj(
      `<< /Type /Page /Parent ${pagesPlaceholderId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  objects[pagesPlaceholderId - 1] = `<< /Type /Pages /Kids [${pageIds
    .map((id) => `${id} 0 R`)
    .join(' ')}] /Count ${pageIds.length} >>`;

  const catalogId = addObj(`<< /Type /Catalog /Pages ${pagesPlaceholderId} 0 R >>`);

  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];
  let cursor = Buffer.byteLength(chunks[0], 'latin1');

  for (let i = 0; i < objects.length; i++) {
    offsets.push(cursor);
    const entry = `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    chunks.push(entry);
    cursor += Buffer.byteLength(entry, 'latin1');
  }

  const xrefStart = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(chunks.join('') + xref + trailer, 'latin1');
}

function drawText(cmds, x, y, text, { size = 10, bold = false, color = '0.12 0.14 0.17' } = {}) {
  cmds.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color} rg 1 0 0 1 ${x} ${y} Tm (${pdfEscape(text)}) Tj ET`);
}

function drawRect(cmds, x, y, w, h, { fill = null, stroke = '0.85 0.82 0.78' } = {}) {
  if (fill) {
    cmds.push(`${fill} rg ${x} ${y} ${w} ${h} re f`);
  }
  if (stroke) {
    cmds.push(`${stroke} RG 0.7 w ${x} ${y} ${w} ${h} re S`);
  }
}

function drawLine(cmds, x1, y1, x2, y2, stroke = '0.82 0.80 0.76') {
  cmds.push(`${stroke} RG 0.6 w ${x1} ${y1} m ${x2} ${y2} l S`);
}

function generateInvoicePdf(invoice, factory) {
  const cmds = [];
  // Header banner
  drawRect(cmds, 36, 735, 523, 72, { fill: '0.96 0.94 0.90', stroke: '0.85 0.80 0.72' });
  drawText(cmds, 48, 785, factory.company_name, { size: 15, bold: true, color: '0.11 0.42 0.29' });
  drawText(cmds, 48, 768, factory.address, { size: 9 });
  drawText(cmds, 48, 754, `GSTIN: ${factory.gstin} | State: ${factory.state_name} (${factory.state_code}) | Ph: ${factory.phone}`, { size: 9 });

  drawText(cmds, 420, 785, 'TAX INVOICE', { size: 15, bold: true, color: '0.76 0.35 0.10' });
  drawText(cmds, 420, 768, `Invoice No: ${invoice.invoice_no}`, { size: 9, bold: true });
  drawText(cmds, 420, 754, `Date: ${invoice.invoice_date} | FY: ${invoice.financial_year}`, { size: 9 });
  if (invoice.status === 'CANCELLED') {
    drawText(cmds, 420, 740, 'STATUS: CANCELLED (CREDIT NOTE)', { size: 8, bold: true, color: '0.75 0.15 0.15' });
  }

  // Bill To & Supply details
  drawRect(cmds, 36, 650, 300, 74, { stroke: '0.85 0.82 0.78' });
  drawText(cmds, 44, 709, 'BILL TO:', { size: 8, bold: true, color: '0.45 0.45 0.45' });
  drawText(cmds, 44, 694, invoice.customer_name, { size: 11, bold: true });
  drawText(cmds, 44, 680, invoice.customer_address || '', { size: 8.5 });
  drawText(cmds, 44, 666, `GSTIN: ${invoice.customer_gstin || 'Unregistered'} | Ph: ${invoice.customer_phone || '-'}`, { size: 8.5 });

  drawRect(cmds, 344, 650, 215, 74, { stroke: '0.85 0.82 0.78' });
  drawText(cmds, 352, 709, 'SUPPLY & ORDER DETAILS:', { size: 8, bold: true, color: '0.45 0.45 0.45' });
  drawText(cmds, 352, 694, `Place of Supply: ${invoice.place_of_supply_state} (${invoice.place_of_supply_code})`, { size: 8.5 });
  drawText(cmds, 352, 680, `Tax Regime: ${invoice.is_interstate ? 'Inter-State (IGST)' : 'Intra-State (CGST + SGST)'}`, { size: 8.5 });
  drawText(cmds, 352, 666, `Order Ref: ${invoice.order_no || '-'} | Due: ${invoice.due_date}`, { size: 8.5 });

  // Table header
  let y = 616;
  drawRect(cmds, 36, y, 523, 22, { fill: '0.11 0.42 0.29', stroke: null });
  const white = '1 1 1';
  drawText(cmds, 42, y + 7, 'Item Description', { size: 8.5, bold: true, color: white });
  drawText(cmds, 195, y + 7, 'HSN', { size: 8.5, bold: true, color: white });
  drawText(cmds, 245, y + 7, 'Qty', { size: 8.5, bold: true, color: white });
  drawText(cmds, 285, y + 7, 'Rate', { size: 8.5, bold: true, color: white });
  drawText(cmds, 338, y + 7, 'Taxable', { size: 8.5, bold: true, color: white });
  drawText(cmds, 398, y + 7, 'CGST/IGST', { size: 8.5, bold: true, color: white });
  drawText(cmds, 456, y + 7, 'SGST', { size: 8.5, bold: true, color: white });
  drawText(cmds, 508, y + 7, 'Total', { size: 8.5, bold: true, color: white });

  y -= 22;
  for (const item of invoice.items || []) {
    drawRect(cmds, 36, y, 523, 22, { stroke: '0.88 0.86 0.82' });
    drawText(cmds, 42, y + 7, item.item_name.slice(0, 28), { size: 8.5 });
    drawText(cmds, 195, y + 7, item.hsn_code || '21069099', { size: 8 });
    drawText(cmds, 245, y + 7, `${item.qty_packets} pkt`, { size: 8.5 });
    drawText(cmds, 285, y + 7, `Rs.${formatPaisa(item.unit_price_paisa)}`, { size: 8.5 });
    drawText(cmds, 338, y + 7, `Rs.${formatPaisa(item.taxable_paisa)}`, { size: 8.5 });
    const col6 = invoice.is_interstate
      ? `Rs.${formatPaisa(item.igst_paisa)}`
      : `Rs.${formatPaisa(item.cgst_paisa)}`;
    const col7 = invoice.is_interstate ? '-' : `Rs.${formatPaisa(item.sgst_paisa)}`;
    drawText(cmds, 398, y + 7, col6, { size: 8.5 });
    drawText(cmds, 456, y + 7, col7, { size: 8.5 });
    drawText(cmds, 504, y + 7, `Rs.${formatPaisa(item.total_paisa)}`, { size: 8.5, bold: true });
    y -= 22;
  }

  // Totals box
  y -= 16;
  drawRect(cmds, 330, y - 92, 229, 100, { fill: '0.98 0.97 0.95', stroke: '0.82 0.78 0.72' });
  drawText(cmds, 342, y - 10, 'Taxable Value:', { size: 9 });
  drawText(cmds, 470, y - 10, `Rs. ${formatPaisa(invoice.taxable_paisa)}`, { size: 9, bold: true });
  if (invoice.is_interstate) {
    drawText(cmds, 342, y - 28, 'IGST (5%):', { size: 9 });
    drawText(cmds, 470, y - 28, `Rs. ${formatPaisa(invoice.igst_paisa)}`, { size: 9 });
  } else {
    drawText(cmds, 342, y - 28, 'CGST (2.5%):', { size: 9 });
    drawText(cmds, 470, y - 28, `Rs. ${formatPaisa(invoice.cgst_paisa)}`, { size: 9 });
    drawText(cmds, 342, y - 46, 'SGST (2.5%):', { size: 9 });
    drawText(cmds, 470, y - 46, `Rs. ${formatPaisa(invoice.sgst_paisa)}`, { size: 9 });
  }
  drawLine(cmds, 340, y - 56, 548, y - 56);
  drawText(cmds, 342, y - 72, 'Invoice Total:', { size: 11, bold: true, color: '0.11 0.42 0.29' });
  drawText(cmds, 464, y - 72, `Rs. ${formatPaisa(invoice.total_paisa)}`, { size: 11, bold: true, color: '0.11 0.42 0.29' });
  drawText(cmds, 342, y - 86, `Paid: Rs. ${formatPaisa(invoice.paid_paisa)} | Due: Rs. ${formatPaisa(invoice.outstanding_paisa)}`, { size: 8.5 });

  drawText(cmds, 36, y - 20, 'Declaration:', { size: 8.5, bold: true });
  drawText(cmds, 36, y - 34, 'We declare that this invoice shows the actual price of goods described', { size: 8 });
  drawText(cmds, 36, y - 46, 'and that all particulars are true and correct. Subject to Tiruchirappalli jurisdiction.', { size: 8 });
  drawText(cmds, 36, 54, `Generated by Order-to-Audit System | Authorised Signatory (${factory.company_name})`, { size: 8, color: '0.45 0.45 0.45' });

  return buildPdfDocument([cmds.join('\n')]);
}

function generateMonthlyReportPdf({ title, subtitle, factory, sections }) {
  const pages = [];
  let cmds = [];
  let y = 795;

  const newPage = () => {
    if (cmds.length > 0) pages.push(cmds.join('\n'));
    cmds = [];
    y = 795;
  };

  drawRect(cmds, 36, 745, 523, 60, { fill: '0.96 0.94 0.90', stroke: '0.85 0.80 0.72' });
  drawText(cmds, 46, 782, `${factory.company_name} - ${title}`, { size: 13, bold: true, color: '0.11 0.42 0.29' });
  drawText(cmds, 46, 764, `${subtitle} | GSTIN: ${factory.gstin}`, { size: 9 });
  drawText(cmds, 46, 751, `Generated: ${new Date().toISOString().slice(0, 10)} | Valuation: ${factory.valuation_method}`, { size: 8, color: '0.4 0.4 0.4' });
  y = 720;

  for (const sec of sections) {
    if (y < 120) newPage();
    drawText(cmds, 36, y, sec.heading, { size: 11, bold: true, color: '0.76 0.35 0.10' });
    y -= 18;

    // Column headers
    drawRect(cmds, 36, y - 4, 523, 18, { fill: '0.11 0.42 0.29', stroke: null });
    sec.columns.forEach((col) => {
      drawText(cmds, col.x, y + 1, col.label, { size: 8, bold: true, color: '1 1 1' });
    });
    y -= 18;

    for (const row of sec.rows) {
      if (y < 60) {
        newPage();
        drawText(cmds, 36, y, `${sec.heading} (contd.)`, { size: 10, bold: true });
        y -= 18;
      }
      drawRect(cmds, 36, y - 4, 523, 16, { stroke: '0.90 0.88 0.85' });
      sec.columns.forEach((col, idx) => {
        drawText(cmds, col.x, y, String(row[idx] ?? '').slice(0, col.max || 28), { size: 7.8 });
      });
      y -= 16;
    }
    y -= 16;
  }

  if (cmds.length > 0) pages.push(cmds.join('\n'));
  return buildPdfDocument(pages);
}

module.exports = {
  generateInvoicePdf,
  generateMonthlyReportPdf,
};
