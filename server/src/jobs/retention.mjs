export async function pruneHistory(db) {
  return db.transaction(async (tx) => {
    const cutoff = "(now() AT TIME ZONE 'Asia/Shanghai')::date-interval '3 months'";
    await tx.query(
      `DELETE FROM changes WHERE line_id IN(SELECT l.id FROM order_lines l JOIN orders o ON o.id=l.order_id WHERE o.meal_date<${cutoff})`,
    );
    await tx.query(
      `DELETE FROM order_lines WHERE order_id IN(SELECT id FROM orders WHERE meal_date<${cutoff})`,
    );
    await tx.query(`DELETE FROM orders WHERE meal_date<${cutoff}`);
    await tx.query(`DELETE FROM prep_checks WHERE meal_date<${cutoff}`);
    await tx.query('DELETE FROM sessions WHERE expires_at<now()');
    await tx.query("DELETE FROM idempotency WHERE created_at<now()-interval '7 days'");
    return { ok: true };
  });
}
