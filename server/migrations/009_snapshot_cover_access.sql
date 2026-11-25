CREATE INDEX order_lines_snapshot_cover ON order_lines ((snapshot->>'coverId'));
CREATE INDEX changes_old_snapshot_cover ON changes ((old_snapshot->>'coverId'));
CREATE INDEX changes_new_snapshot_cover ON changes ((new_snapshot->>'coverId'));
