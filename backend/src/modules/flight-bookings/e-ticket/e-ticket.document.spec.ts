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

describe('e-ticket of a round trip (FLT-12)', () => {
  const roundTrip: ETicketData = {
    ...ticket,
    return: {
      flightNumber: 'XY124',
      airline: { name: 'Gulf Air', code: 'GF' },
      departure: { code: 'DXB', name: 'Dubai International', timeZone: 'Asia/Dubai', time: new Date('2030-01-20T08:00:00.000Z') },
      arrival: { code: 'CAI', name: 'Cairo International', timeZone: 'Africa/Cairo', time: new Date('2030-01-20T12:00:00.000Z') },
      cabinClass: 'Business',
      baggage: null,
    },
  };

  it('prints both flights: the outbound as before, then the return', () => {
    const lines = Object.fromEntries(eTicketLines(roundTrip).map((l) => [l.label, l.value]));
    expect(lines.Trip).toBe('Round trip');
    expect(lines.Flight).toBe('XY123');
    expect(lines['Return flight']).toBe('XY124');
    expect(lines['Return airline']).toBe('Gulf Air (GF)');
    expect(lines['Return from']).toBe('DXB - Dubai International');
    expect(lines['Return departure']).toBe('2030-01-20 12:00 (local, UTC+04:00)');
    expect(lines['Return arrival']).toBe('2030-01-20 14:00 (local, UTC+02:00)');
    expect(lines['Return cabin']).toBe('Business');
    expect(lines['Return baggage']).toBe('See the airline baggage policy');
  });

  it('a one-way ticket has no return lines', () => {
    expect(eTicketLines(ticket).some((l) => l.label.startsWith('Return') || l.label === 'Trip')).toBe(false);
  });
});
