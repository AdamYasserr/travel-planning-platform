import type { DemoSeedSummary } from './demo-seed';

/** The credentials and ids to paste into Swagger. The password is printed once, here, by design. */
export function formatSummary(summary: DemoSeedSummary, password: string): string {
  const created = summary.manifestAfter - summary.manifestBefore;
  const lines: string[] = [];
  lines.push('');
  lines.push(created === 0 ? 'Nothing new was created: the demo data already exists.' : `Created ${created} seeded document(s).`);
  lines.push(`Currency of every seeded price: ${summary.currency}`);
  lines.push(`Route: ${summary.route.from.iata} (${summary.route.from.cityName}) -> ${summary.route.to.iata} (${summary.route.to.cityName})`);
  lines.push('');
  lines.push('Users');
  for (const u of summary.users) lines.push(`  ${u.email.padEnd(30)} ${u.role.padEnd(10)} ${u.id}`);
  lines.push(`  Password of every demo user: ${password}  (set SEED_PASSWORD to change it)`);
  lines.push('');
  lines.push(`Airline  ${summary.airlineId}`);
  lines.push(`Hotel    ${summary.hotelId}`);
  for (const r of summary.rooms) lines.push(`  room ${r.name.padEnd(18)} ${r.id}`);
  lines.push('Flights');
  for (const f of summary.flights) lines.push(`  ${f.number} ${f.route.padEnd(10)} ${f.key.padEnd(9)} ${f.id}`);
  lines.push('Bookings (customer Sara)');
  for (const b of summary.bookings) lines.push(`  ${b.key.padEnd(17)} ${b.status.padEnd(16)} ${b.reference.padEnd(44)} ${b.id}`);
  lines.push('Itineraries');
  for (const i of summary.itineraries) lines.push(`  ${i.key.padEnd(16)} ${i.visibility.padEnd(8)} ${i.id}  ${i.title}`);
  for (const note of summary.notes) lines.push(`NOTE: ${note}`);
  return lines.join('\n');
}
