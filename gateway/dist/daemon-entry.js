#!/usr/bin/env node
import { runDaemon } from './daemon.js';
runDaemon().catch(error => { console.error(`daemon_error=${error instanceof Error ? error.message : 'unknown'}`); process.exit(1); });
