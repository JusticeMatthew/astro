import fs from 'node:fs';
import path from 'node:path';
import { color } from '@astrojs/cli-kit';
import { downloadTemplate } from '@bluwy/giget-core';
import { error, info, title } from '../messages.js';
import type { Context } from './context.js';

/**
 * Removes sections from README content that are marked with HTML template markers.
 *
 * Template marker format:
 * <!-- ASTRO:REMOVE:START -->
 * Content to remove
 * <!-- ASTRO:REMOVE:END -->
 */
export function removeTemplateMarkerSections(content: string): string {
	// Pattern to match HTML template marker sections
	const pattern = /<!--\s*ASTRO:REMOVE:START\s*-->[\s\S]*?<!--\s*ASTRO:REMOVE:END\s*-->/gi;

	let result = content.replace(pattern, '');

	// Clean up extra whitespace that might be left behind
	// Replace multiple consecutive newlines with at most 2 newlines
	result = result.replace(/\n{3,}/g, '\n\n');

	return result;
}

/**
 * Processes a template README file by removing template marker sections and
 * replacing package manager references.
 */
export function processTemplateReadme(content: string, packageManager: string): string {
	// Remove sections marked with template markers
	let processed = removeTemplateMarkerSections(content);

	// Replace package manager references if not npm
	if (packageManager !== 'npm') {
		processed = processed
			.replace(/\bnpm run\b/g, packageManager)
			.replace(/\bnpm\b/g, packageManager);
	}

	return processed;
}

export async function template(
	ctx: Pick<Context, 'template' | 'prompt' | 'yes' | 'dryRun' | 'exit' | 'tasks'>,
) {
	if (!ctx.template && ctx.yes) ctx.template = 'basics';

	if (ctx.template) {
		await info('tmpl', `Using ${color.reset(ctx.template)}${color.dim(' as project template')}`);
	} else {
		const { template: tmpl } = await ctx.prompt({
			name: 'template',
			type: 'select',
			label: title('tmpl'),
			message: 'How would you like to start your new project?',
			initial: 'basics',
			choices: [
				{ value: 'basics', label: 'A basic, helpful starter project', hint: '(recommended)' },
				{ value: 'blog', label: 'Use blog template' },
				{ value: 'starlight', label: 'Use docs (Starlight) template' },
				{ value: 'minimal', label: 'Use minimal (empty) template' },
			],
		});
		ctx.template = tmpl;
	}

	if (ctx.dryRun) {
		await info('--dry-run', `Skipping template copying`);
	} else if (ctx.template) {
		ctx.tasks.push({
			pending: 'Template',
			start: 'Template copying...',
			end: 'Template copied',
			while: () =>
				copyTemplate(ctx.template!, ctx as Context).catch((e) => {
					if (e instanceof Error) {
						error('error', e.message);
						process.exit(1);
					} else {
						error('error', 'Unable to clone template.');
						process.exit(1);
					}
				}),
		});
	} else {
		ctx.exit(1);
	}
}

// some files are only needed for online editors when using astro.new. Remove for create-astro installs.
const FILES_TO_REMOVE = ['CHANGELOG.md', '.codesandbox'];
const FILES_TO_UPDATE = {
	'package.json': (file: string, overrides: { name: string }) =>
		fs.promises.readFile(file, 'utf-8').then((value) => {
			// Match first indent in the file or fallback to `\t`
			const indent = /(^\s+)/m.exec(value)?.[1] ?? '\t';
			return fs.promises.writeFile(
				file,
				JSON.stringify(
					Object.assign(JSON.parse(value), Object.assign(overrides, { private: undefined })),
					null,
					indent,
				),
				'utf-8',
			);
		}),
};

export function getTemplateTarget(tmpl: string, ref = 'latest') {
	// Handle Starlight templates
	if (tmpl.startsWith('starlight')) {
		const [, starter = 'basics'] = tmpl.split('/');
		return `github:withastro/starlight/examples/${starter}`;
	}

	// Handle third-party templates
	const isThirdParty = tmpl.includes('/');
	if (isThirdParty) return tmpl;

	// Handle Astro templates
	if (ref === 'latest') {
		// `latest` ref is specially handled to route to a branch specifically
		// to allow faster downloads. Otherwise giget has to download the entire
		// repo and only copy a sub directory
		return `github:withastro/astro#examples/${tmpl}`;
	} else {
		return `github:withastro/astro/examples/${tmpl}#${ref}`;
	}
}

async function copyTemplate(tmpl: string, ctx: Context) {
	const templateTarget = getTemplateTarget(tmpl, ctx.ref);
	// Copy
	if (!ctx.dryRun) {
		try {
			await downloadTemplate(templateTarget, {
				force: true,
				cwd: ctx.cwd,
				dir: '.',
			});

			// Process the README file to remove marked sections and update package manager
			const readmePath = path.resolve(ctx.cwd, 'README.md');
			if (fs.existsSync(readmePath)) {
				const readme = fs.readFileSync(readmePath, 'utf8');
				const processedReadme = processTemplateReadme(readme, ctx.packageManager);
				fs.writeFileSync(readmePath, processedReadme);
			}
		} catch (err: any) {
			// Only remove the directory if it's most likely created by us.
			if (ctx.cwd !== '.' && ctx.cwd !== './' && !ctx.cwd.startsWith('../')) {
				try {
					fs.rmdirSync(ctx.cwd);
				} catch (_) {
					// Ignore any errors from removing the directory,
					// make sure we throw and display the original error.
				}
			}

			if (err.message?.includes('404')) {
				throw new Error(`Template ${color.reset(tmpl)} ${color.dim('does not exist!')}`);
			}

			if (err.message) {
				error('error', err.message);
			}
			try {
				// The underlying error is often buried deep in the `cause` property
				// This is in a try/catch block in case of weirdnesses in accessing the `cause` property
				if ('cause' in err) {
					// This is probably included in err.message, but we can log it just in case it has extra info
					error('error', err.cause);
					if ('cause' in err.cause) {
						// Hopefully the actual fetch error message
						error('error', err.cause?.cause);
					}
				}
			} catch {}
			throw new Error(`Unable to download template ${color.reset(tmpl)}`);
		}

		// Post-process in parallel
		const removeFiles = FILES_TO_REMOVE.map(async (file) => {
			const fileLoc = path.resolve(path.join(ctx.cwd, file));
			if (fs.existsSync(fileLoc)) {
				return fs.promises.rm(fileLoc, { recursive: true });
			}
		});
		const updateFiles = Object.entries(FILES_TO_UPDATE).map(async ([file, update]) => {
			const fileLoc = path.resolve(path.join(ctx.cwd, file));
			if (fs.existsSync(fileLoc)) {
				return update(fileLoc, { name: ctx.projectName! });
			}
		});

		await Promise.all([...removeFiles, ...updateFiles]);
	}
}
