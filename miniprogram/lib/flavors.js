const session = require('./session');
function begin(page, dish) {
  const selections = {};
  for (const row of session.cartOptions?.[dish.id] || [])
    selections[row.groupId] = [...row.choiceIds];
  page.setData({
    showOptions: true,
    optionDishId: dish.id,
    optionDishName: dish.name,
    optionSelections: selections,
    optionGroupsDisplay: display(dish.optionGroups || [], selections),
  });
}
function display(groups, selections) {
  return groups.map((group) => ({
    ...group,
    choices: group.choices.map((choice) => ({
      ...choice,
      checked: (selections[group.id] || []).includes(choice.id),
    })),
  }));
}
function choose(page, event) {
  const { group, choice } = event.currentTarget.dataset;
  const source = page.data.optionGroupsDisplay.find((x) => x.id === group);
  if (!source) return;
  const selections = { ...page.data.optionSelections };
  const old = selections[group] || [];
  selections[group] =
    source.mode === 'single'
      ? [choice]
      : old.includes(choice)
        ? old.filter((x) => x !== choice)
        : [...old, choice];
  page.setData({
    optionSelections: selections,
    optionGroupsDisplay: display(page.data.optionGroupsDisplay, selections),
  });
}
function finish(page, persist = true) {
  const rows = page.data.optionGroupsDisplay.map((group) => ({
    groupId: group.id,
    choiceIds: page.data.optionSelections[group.id] || [],
  }));
  if (rows.some((row) => !row.choiceIds.length)) throw Error('每组口味至少选一项');
  if (persist) {
    session.cartOptions ||= {};
    session.cartOptions[page.data.optionDishId] = rows;
  }
  page.setData({ showOptions: false });
  return { id: page.data.optionDishId, rows };
}
function summary(dish, selected) {
  return (selected || [])
    .map((row) => {
      const group = (dish.optionGroups || []).find((g) => g.id === row.groupId);
      return group
        ? group.title +
            '：' +
            group.choices
              .filter((c) => row.choiceIds.includes(c.id))
              .map((c) => c.label)
              .join('、')
        : '';
    })
    .filter(Boolean)
    .join(' · ');
}
module.exports = { begin, choose, finish, summary };
