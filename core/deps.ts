export { parse as parseToml } from 'https://deno.land/std@0.180.0/encoding/toml.ts';
import * as log from 'https://deno.land/std@0.180.0/log/mod.ts';

await log.setup({
	handlers: {
		console: new log.handlers.ConsoleHandler('DEBUG'),
	},
});

export { log };
