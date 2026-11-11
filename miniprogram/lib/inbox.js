const tabs = [
  { id: 'order', name: '点菜通知' },
  { id: 'change', name: '换菜通知' },
  { id: 'cooking', name: '做菜确认' },
  { id: 'family', name: '小家通知' },
];
function category(note) {
  if (note.type === 'cooking.reminder') return 'cooking';
  return note.type.startsWith('order.')
    ? 'order'
    : note.type.startsWith('change.')
      ? 'change'
      : 'family';
}
function summarize(notes) {
  return tabs.map((t) => ({
    ...t,
    unread: notes.filter((n) => category(n) === t.id && !n.read_at).length,
  }));
}
function initial(notes) {
  return summarize(notes).find((t) => t.unread > 0)?.id || 'order';
}
module.exports = { category, summarize, initial };
