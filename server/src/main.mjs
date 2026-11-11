import { buildApp } from './app.mjs';
import { queueCookingReminders } from './modules/meals/cooking.mjs';
import { pruneHistory } from './jobs/retention.mjs';
import { deliverNotifications, wechatNotificationSender } from './modules/notifications/wechat.mjs';
const { app, db, config } = await buildApp();
await pruneHistory(db);
await queueCookingReminders(db);
let checkingCooking = false;
const cookingTimer = setInterval(async () => {
  if (checkingCooking) return;
  checkingCooking = true;
  try {
    await queueCookingReminders(db);
  } catch {
    app.log.error('Cooking reminders failed');
  } finally {
    checkingCooking = false;
  }
}, 60000);
cookingTimer.unref();
const timer = setInterval(
  () => pruneHistory(db).catch(() => app.log.error('Retention job failed')),
  6 * 60 * 60 * 1000,
);
timer.unref();
const sendWechat = wechatNotificationSender(config);
let delivering = false;
const notificationTimer = setInterval(async () => {
  if (delivering) return;
  delivering = true;
  try {
    await deliverNotifications(db, config, sendWechat);
  } catch {
    app.log.error('Notification delivery failed');
  } finally {
    delivering = false;
  }
}, 15000);
notificationTimer.unref();
await app.listen({ host: config.host, port: config.port });
console.log('给我饭 API: ' + config.origin);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    clearInterval(timer);
    clearInterval(cookingTimer);
    clearInterval(notificationTimer);
    await app.close();
    process.exit(0);
  });
