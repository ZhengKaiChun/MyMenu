import { archiveAchievements } from '../modules/meals/achievements.mjs';
export async function pruneHistory(db) {
  return db.transaction(async (tx) => {
    const cutoff = "(now() AT TIME ZONE 'Asia/Shanghai')::date-interval '3 months'";
    await archiveAchievements(tx, cutoff);
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
    await tx.query("DELETE FROM sms_challenges WHERE expires_at<now()-interval '1 day'");
    await tx.query('DELETE FROM sms_limits WHERE day<current_date-7');
    await tx.query("DELETE FROM notifications WHERE created_at<now()-interval '3 months'");
    return { ok: true };
  });
}
