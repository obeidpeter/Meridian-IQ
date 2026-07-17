
## Postgres dies silently in this container

The local Postgres 16 cluster is occasionally SIGKILLed with nothing in its
log (it ends mid-checkpoint; no OOM record, memory plentiful). Every DB-backed
test then fails with "Failed query: insert ..." / connection refused. Do not
debug the tests — check `pg_lsclusters`, run
`sudo pg_ctlcluster 16 main start`, and re-run. Seen repeatedly (rounds 10
and 11).
