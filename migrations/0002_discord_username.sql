-- The agent shows who this PC is paired with, and an id is not a name a person
-- recognises. Nullable, because every row that exists predates this column and
-- fills in the next time its owner runs /coach connect.
ALTER TABLE users ADD COLUMN discord_username TEXT;
