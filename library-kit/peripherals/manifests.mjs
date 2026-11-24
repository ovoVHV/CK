import fs from 'node:fs';
import path from 'node:path';
import { build } from './build-kit.mjs';
import servo from './profiles/servo.mjs';
import dht from './profiles/dht22.mjs';
import oled from './profiles/oled.mjs';

// Called by build.py after it has exclusively created the output directory.
const output = path.resolve(process.argv[2]);
const profiles = [servo, oled, dht];
for (const profile of profiles) build(profile, output);
fs.writeFileSync(path.join(output,'upstream.json'), JSON.stringify(Object.fromEntries(
  profiles.map(profile => [profile.id, profile.drivers])
), null, 2));
