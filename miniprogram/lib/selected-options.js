module.exports = function selectedOptions(snapshot) {
  return (snapshot?.selectedOptions || [])
    .map(
      (group) =>
        group.title + '：' + (group.choices || []).map((choice) => choice.label).join('、'),
    )
    .join(' · ');
};
