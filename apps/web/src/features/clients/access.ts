/**
 * What a client's page shows to whom. Field crew ("Employee") look any client up, for how to reach
 * them, their properties and their history (notes and texts), but not the work sold to them or what
 * it costs: the database gives them no quotes, invoices or job totals either.
 */
export const lookupOnly = (session: { role: string }) => session.role === "field_crew";
