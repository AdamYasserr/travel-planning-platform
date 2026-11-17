import { eTicketLines, renderETicketPdf, type ETicketData } from './e-ticket.document';

const ticket: ETicketData = {
  reference: 'FLT-abc',
  status: 'Confirmed',
  passengers: ['Taylor Passenger', 'Morgan Passenger'],
  flightNumber: 'XY123',
  airline: { name: 'Nile Air', code: 'XY' },
  departure: { code: 'CAI', name: 'Cairo International', timeZone: 'Africa/Cairo', time: new Date('2030-01-15T08:00:00.000Z') },
  arrival: { code: 'DXB', name: 'Dubai International', timeZone: 'Asia/Dubai', time: new Date('2030-01-15T12:00:00.000Z') },
  cabinClass: 'Economy',
  baggage: { freeBagsCount: 1, maxWeightPerBagKg: 23, carryOnAllowanceKg: 7 },
  totalPaid: 10000,
  currency: 'egp',
};

describe('e-ticket (FLT-23)', () => {
  it('prints every required field, with airport-local times', () => {
    const lines = Object.fromEntries(eTicketLines(ticket).map((l) => [l.label, l.value]));
    expect(lines['Booking reference']).toBe('FLT-abc');
    expect(lines.Passengers).toBe('Taylor Passenger, Morgan Passenger');
    expect(lines.Flight).toBe('XY123');
    expect(lines.Airline).toBe('Nile Air (XY)');
    expect(lines.From).toBe('CAI - Cairo International');
    expect(lines.Departure).toBe('2030-01-15 10:00 (local, UTC+02:00)');
    expect(lines.Arrival).toBe('2030-01-15 16:00 (local, UTC+04:00)');
    expect(lines.Cabin).toBe('Economy');
    expect(lines.Baggage).toBe('1 checked bag(s) up to 23 kg each, carry-on 7 kg');
    expect(lines['Total paid']).toBe('10000.00 EGP');
  });

  it('renders a non-empty PDF', async () => {
    const pdf = await renderETicketPdf(ticket);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  });
});
