#!/bin/bash
set -e

chown -R openclaw:openclaw /data
chmod 700 /data

exec gosu openclaw node src/server.js
