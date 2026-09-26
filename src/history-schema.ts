// Shared by the indexer (worker, writes) and the server (reads).
import { homedir } from "node:os";

export const HISTORY_DB = process.env.DECK_HISTORY_DB ?? `${homedir()}/.config/herdr-deck/history.db`;

export const SCHEMA = `
create table if not exists sess (
  file text primary key, id text not null, agent text not null, cwd text, project text, root text,
  title text, first text, started integer, last integer, asks integer, model text,
  size integer, mtime real, ino integer, msgs integer, gen integer, empty integer default 0
);
create index if not exists sess_last on sess(last desc);
create index if not exists sess_id on sess(id);
create virtual table if not exists msg using fts5(text, file unindexed, i unindexed, role unindexed, at unindexed, tokenize = 'unicode61 remove_diacritics 2');
`;
