import PDFDocument from 'pdfkit';

import { toLocalInstant } from '../../flights/timezone.util';

/** Everything printed on an e-ticket (FLT-23). */
export interface ETicketData {
  reference: string;
  status: string;
  passengers: string[];
  flightNumber: string;
  airline: { name: string; code: string };
  departure: { code: string; name: string; timeZone: string; time: Date };
  arrival: { code: string; name: string; timeZone: string; time: Date };
  cabinClass: string;
  baggage: {
    freeBagsCount: number;
    maxWeightPerBagKg: number;
    carryOnAllowanceKg?: number;
    checkedBaggageAllowanceKg?: number;
  } | null;
  totalPaid: number;
  currency: string;
}

const localTime = (time: Date, timeZone: string) => {
  const l = toLocalInstant(time, timeZone);
  return `${l.local.slice(0, 10)} ${l.local.slice(11, 16)} (local, UTC${l.utcOffset})`;
};

/** The ticket as labelled lines. Pure, so its contents are unit-tested; the PDF prints exactly these. */
export function eTicketLines(t: ETicketData): { label: string; value: string }[] {
  const baggage = t.baggage
    ? [
        `${t.baggage.freeBagsCount} checked bag(s) up to ${t.baggage.maxWeightPerBagKg} kg each`,
        ...(t.baggage.carryOnAllowanceKg !== undefined ? [`carry-on ${t.baggage.carryOnAllowanceKg} kg`] : []),
      ].join(', ')
    : 'See the airline baggage policy';
  return [
    { label: 'Booking reference', value: t.reference },
    { label: 'Status', value: t.status },
    { label: 'Passengers', value: t.passengers.join(', ') },
    { label: 'Airline', value: `${t.airline.name} (${t.airline.code})` },
    { label: 'Flight', value: t.flightNumber },
    { label: 'From', value: `${t.departure.code} - ${t.departure.name}` },
    { label: 'Departure', value: localTime(t.departure.time, t.departure.timeZone) },
    { label: 'To', value: `${t.arrival.code} - ${t.arrival.name}` },
    { label: 'Arrival', value: localTime(t.arrival.time, t.arrival.timeZone) },
    { label: 'Cabin', value: t.cabinClass },
    { label: 'Seat', value: 'Assigned at check-in' },
    { label: 'Baggage', value: baggage },
    { label: 'Total paid', value: `${t.totalPaid.toFixed(2)} ${t.currency.toUpperCase()}` },
  ];
}

/** Renders the e-ticket PDF into memory. */
export function renderETicketPdf(t: ETicketData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `E-ticket ${t.reference}`, Author: 'Travel Planning Platform' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(22).font('Helvetica-Bold').text('Electronic ticket');
    doc.moveDown(0.3).fontSize(11).font('Helvetica').fillColor('#555555').text('Present this e-ticket with a valid ID at check-in.');
    doc.moveDown(1).fillColor('#000000');
    for (const line of eTicketLines(t)) {
      doc.fontSize(10).font('Helvetica-Bold').text(line.label, { continued: false });
      doc.fontSize(12).font('Helvetica').text(line.value);
      doc.moveDown(0.5);
    }
    doc.end();
  });
}
