#!/usr/bin/env node
/**
 * Publish a release's installers to Gitee.
 *
 * Why this exists as a *local* helper instead of a CI step
 * ───────────────────────────────────────────────────────
 * Uploading the installers from a GitHub-hosted runner to Gitee was measured at
 * "18 minutes, zero bytes landed" — the cross-border upload path is unusable for
 * ~95 MB files. The same four files upload at ~4 MiB/s from a machine inside
 * China, so publishing to Gitee is a single local command instead:
 *
 *   pnpm release:gitee v0.1.0-beta
 *
 * Credentials are never stored in this repository. The Gitee token is read from
 * the OS credential store through `git credential fill`, so the only setup is
 * (once):
 *
 *   git credential approve          # protocol=https host=gitee.com
 *                                   # username=<you> password=<私人令牌>
 *
 * Gitee limits (verified against the live API, not just the docs):
 *   - per attachment     100 MiB (104,857,600 bytes)
 *   - per repository     1 GiB total across every release's attachments
 * Deletion endpoints (releases / attachments) currently answer 401 for personal
 * access tokens, so this script *detects* an over-quota situation and tells you
 * what to delete in the web UI instead of silently failing halfway.
 *
 * Usage
 *   node scripts/publish-gitee-release.mjs [tag] [options]
 *
 * Options
 *   --source github|local   where the installers come from (default: github)
 *   --dir <path>            directory for --source local
 *                           (default: packages/desktop/release)
 *   --owner <owner>         Gitee repository owner (default: xusy545)
 *   --repo <repo>           Gitee repository name  (default: robrowser)
 *   --gh-repo <owner/name>  GitHub repository holding the release
 *                           (default: Mio545/robrowser)
 *   --force                 re-upload attachments that already exist
 *   --dry-run               do everything except download/upload
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Gitee rejects a single attachment at or above this size. */
const GITEE_MAX_ATTACHMENT = 100 * 1024 * 1024; // 100 MiB, verified empirically
/** Gitee counts every release's attachments against this per-repository budget. */
const GITEE_MAX_TOTAL = 1024 * 1024 * 1024; // 1 GiB

/** Installer extensions we publish, in the order they appear on the release. */
const INSTALLER_EXTENSIONS = ['.exe', '.dmg', '.AppImage'];

/* --------------------------------------------------------------------- args */

function parseArgs(argv) {
  const options = {
    tag: undefined,
    source: 'github',
    dir: join(REPO_ROOT, 'packages', 'desktop', 'release'),
    owner: 'xusy545',
    repo: 'robrowser',
    ghRepo: 'Mio545/robrowser',
    force: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') options.source = argv[++i];
    else if (arg === '--dir') options.dir = resolve(argv[++i]);
    else if (arg === '--owner') options.owner = argv[++i];
    else if (arg === '--repo') options.repo = argv[++i];
    else if (arg === '--gh-repo') options.ghRepo = argv[++i];
    else if (arg === '--force') options.force = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`未知选项 ${arg}`);
    else options.tag = arg;
  }
  return options;
}

/* -------------------------------------------------------------- credentials */

/**
 * Read a credential.
 *
 * `GITEE_TOKEN` / `GITHUB_TOKEN` in the environment win (handy in CI or a
 * container). Otherwise the OS credential store is asked through
 * `git credential fill`; `credential.helper=` clears the configured helper list
 * first so the plaintext `~/.git-credentials` file is neither read nor written,
 * leaving only the platform store (Git Credential Manager on Windows).
 */
function readCredential(host, required) {
  const envName = host.startsWith('gitee') ? 'GITEE_TOKEN' : 'GITHUB_TOKEN';
  if (process.env[envName]) return { username: `(来自 ${envName})`, password: process.env[envName] };

  // Prefer `git` from PATH; fall back to the Windows install location.
  const candidates = ['git', 'C:/Program Files/Git/cmd/git.exe'];
  let binary = null;
  let lastError = null;
  for (const candidate of candidates) {
    if (candidate !== 'git' && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error) {
      binary = candidate;
      break;
    }
    lastError = probe.error;
  }
  if (!binary) {
    if (required) {
      throw new Error(
        `找不到可用的 git（${lastError?.message ?? '未知原因'}）。` +
          `可以改为设置环境变量 ${envName} 后重跑。`,
      );
    }
    return null;
  }

  const result = spawnSync(
    binary,
    ['-c', 'credential.helper=', '-c', 'credential.helper=manager', 'credential', 'fill'],
    {
      input: `protocol=https\nhost=${host}\n\n`,
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    },
  );
  const fields = Object.fromEntries(
    (result.stdout ?? '')
      .split(/\r?\n/)
      .filter((line) => line.includes('='))
      .map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  if (!fields.password) {
    if (!required) return null;
    throw new Error(
      `凭据库里没有 ${host} 的令牌。先执行一次：\n` +
        `  git credential approve    # protocol=https host=${host} username=<账号> password=<私人令牌>`,
    );
  }
  return { username: fields.username, password: fields.password };
}

/* ------------------------------------------------------------------- Gitee */

function giteeApi(options) {
  return `https://gitee.com/api/v5/repos/${options.owner}/${options.repo}`;
}

async function giteeGet(url, token) {
  const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}access_token=${token}`, {
    headers: { 'User-Agent': 'robrowser-release' },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`GET ${url} -> HTTP ${response.status} ${body.slice(0, 200)}`);
  const parsed = JSON.parse(body || 'null');
  // Gitee answers `200` with a `null` body for an unknown tag rather than 404.
  if (parsed === null) throw new Error(`GET ${url} -> 空响应（对象不存在）`);
  return parsed;
}

/**
 * Find the Gitee release for a tag, creating it when missing.
 *
 * The by-tag lookup returns `null` when the tag was deleted from git while its
 * release survived, so the release list is scanned as a fallback before creating
 * a duplicate.
 */
async function ensureRelease(options, token, tag) {
  try {
    return await giteeGet(`${giteeApi(options)}/releases/tags/${tag}`, token);
  } catch {
    /* fall through to the list lookup */
  }

  const releases = await giteeGet(`${giteeApi(options)}/releases`, token);
  const existing = releases.find((release) => release.tag_name === tag);
  if (existing) return existing;
  console.log(`   （现有发行版：${releases.map((r) => r.tag_name).join(', ') || '无'}，将新建 ${tag}）`);

  const response = await fetch(`${giteeApi(options)}/releases`, {
    method: 'POST',
    headers: {
      // Gitee rejects the body outright when the content type carries a charset
      // parameter ("body is missing"), so send the bare type.
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'robrowser-release',
    },
    body: new URLSearchParams({
      access_token: token,
      tag_name: tag,
      name: `RoboBrowser ${tag}`,
      // Gitee requires a non-empty `body`; without it the API answers
      // `400 {"messages":["body is missing"]}`.
      body:
        `安装包见本发行版附件。\n\n` +
        `各平台产物与完整发行说明也发布在 GitHub：` +
        `https://github.com/${options.ghRepo}/releases/tag/${tag}`,
      target_commitish: 'master',
      prerelease: /-/.test(tag) ? 'true' : 'false',
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`创建 Gitee 发行版失败：HTTP ${response.status} ${await response.text()}`);
  }
  const created = await response.json();
  if (!created?.id) throw new Error(`创建 Gitee 发行版失败：响应中没有 id（${JSON.stringify(created).slice(0, 200)}）`);
  return created;
}

/** Every attachment of the repository, keyed by release id. */
async function listAllAttachments(options, token) {
  const releases = await giteeGet(`${giteeApi(options)}/releases`, token);
  const perRelease = [];
  for (const release of releases) {
    const attachments = await giteeGet(
      `${giteeApi(options)}/releases/${release.id}/attach_files`,
      token,
    );
    perRelease.push({ release, attachments });
  }
  return perRelease;
}

/**
 * Upload one file.
 *
 * Uses Undici's `fetch` with a `FormData` body rather than shelling out to curl,
 * so the script has no external tool dependency. Gitee's own limit is 100 MiB,
 * which is fine to hold in memory for the length of one request.
 */
async function uploadFile(url, token, filePath, fileName) {
  const { readFileSync } = await import('node:fs');
  const form = new FormData();
  form.set('access_token', token);
  form.set('file', new Blob([readFileSync(filePath)]), fileName);

  const response = await fetch(url, {
    method: 'POST',
    body: form,
    headers: { 'User-Agent': 'robrowser-release' },
  });
  const body = await response.text();
  return { status: response.status, body: body.slice(0, 300) };
}

/* ------------------------------------------------------------------ source */

/** Resolve the installer list from the GitHub release (name + size + url). */
async function assetsFromGitHub(options, ghToken) {
  const headers = { 'User-Agent': 'robrowser-release', Accept: 'application/vnd.github+json' };
  if (ghToken) headers.Authorization = `token ${ghToken}`;
  const base = `https://api.github.com/repos/${options.ghRepo}`;

  let tag = options.tag;
  if (!tag) {
    const latest = await fetch(`${base}/releases?per_page=1`, { headers });
    if (!latest.ok) throw new Error(`读取 GitHub 发行版失败：HTTP ${latest.status}`);
    const [first] = await latest.json();
    if (!first) throw new Error('GitHub 上没有发行版，请显式指定标签');
    tag = first.tag_name;
  }

  const response = await fetch(`${base}/releases/tags/${tag}`, { headers });
  if (!response.ok) throw new Error(`GitHub 上找不到标签 ${tag}（HTTP ${response.status}）`);
  const release = await response.json();
  return {
    tag,
    files: release.assets
      .filter((asset) => INSTALLER_EXTENSIONS.some((ext) => asset.name.endsWith(ext)))
      .map((asset) => ({ name: asset.name, size: asset.size, url: asset.browser_download_url })),
    downloadTo: join(REPO_ROOT, 'work', 'assets'),
  };
}

/** Resolve the installer list from a local directory. */
function assetsFromLocal(options) {
  if (!existsSync(options.dir)) throw new Error(`目录不存在：${options.dir}`);
  const files = readdirSync(options.dir)
    .filter((name) => INSTALLER_EXTENSIONS.some((ext) => name.endsWith(ext)))
    .map((name) => {
      const path = join(options.dir, name);
      return { name, size: statSync(path).size, path };
    });
  return { tag: options.tag, files, downloadTo: null };
}

async function download(file, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const path = join(targetDir, file.name);
  if (existsSync(path) && statSync(path).size === file.size) return path;
  process.stdout.write(`    下载 ${file.name} … `);
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  console.log('完成');
  return path;
}

/* -------------------------------------------------------------------- main */

function human(bytes) {
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      '用法：node scripts/publish-gitee-release.mjs [tag] [--source github|local]\n' +
        '        [--dir <目录>] [--owner xusy545] [--repo robrowser] [--force] [--dry-run]',
    );
    return;
  }

  const gitee = readCredential('gitee.com', true);
  const github = readCredential('github.com', false);
  console.log(`凭据：Gitee=${gitee.username}${github ? `，GitHub=${github.username}` : ''}`);

  const source =
    options.source === 'github'
      ? await assetsFromGitHub(options, github?.password)
      : assetsFromLocal(options);
  const tag = source.tag ?? options.tag;
  if (!tag) throw new Error('无法确定标签，请显式指定（例如 v0.1.0-beta）');
  console.log(`标签：${tag}    来源：${options.source}`);

  if (source.files.length === 0) throw new Error('没有找到任何安装包');

  /* ---- preflight: per-file and per-repository limits -------------------- */
  const tooBig = source.files.filter((file) => file.size >= GITEE_MAX_ATTACHMENT);
  const uploadable = source.files.filter((file) => file.size < GITEE_MAX_ATTACHMENT);
  for (const file of tooBig) {
    console.warn(
      `  ⚠ 跳过 ${file.name}（${human(file.size)}）：超过 Gitee 单附件上限 ${human(GITEE_MAX_ATTACHMENT)}`,
    );
  }

  const release = await ensureRelease(options, gitee.password, tag);
  const all = await listAllAttachments(options, gitee.password);
  const existing = new Set(
    all.find((entry) => entry.release.id === release.id)?.attachments.map((a) => a.name) ?? [],
  );
  const usedTotal = all.reduce(
    (sum, entry) => sum + entry.attachments.reduce((s, a) => s + a.size, 0),
    0,
  );
  const pending = uploadable.filter((file) => options.force || !existing.has(file.name));
  const addedTotal = pending.reduce((sum, file) => sum + file.size, 0);

  console.log(
    `\n仓库现有附件合计 ${human(usedTotal)} / ${human(GITEE_MAX_TOTAL)}；` +
      `本次将上传 ${pending.length} 个，共 ${human(addedTotal)}`,
  );
  if (usedTotal + addedTotal > GITEE_MAX_TOTAL) {
    console.warn(
      '\n⚠ 超出 Gitee 单仓库 1 GiB 附件总额。删除接口对个人令牌返回 401，无法自动清理；\n' +
        '   请到 Gitee 网页上删掉旧版本的附件后重跑：\n' +
        `   https://gitee.com/${options.owner}/${options.repo}/releases`,
    );
    process.exitCode = 1;
    return;
  }

  if (options.dryRun) {
    console.log('\n--dry-run：不做下载与上传。将要上传的文件：');
    for (const file of pending) console.log(`  - ${file.name}  ${human(file.size)}`);
    return;
  }

  /* ---- upload ----------------------------------------------------------- */
  console.log('');
  let uploaded = 0;
  for (const file of pending) {
    const path = file.path ?? (await download(file, source.downloadTo));
    process.stdout.write(`  上传 ${file.name}（${human(file.size)}）… `);
    const result = await uploadFile(
      `${giteeApi(options)}/releases/${release.id}/attach_files`,
      gitee.password,
      path,
      file.name,
    );
    if (result.status === 200 || result.status === 201) {
      uploaded += 1;
      console.log('OK');
    } else {
      console.log(`失败（HTTP ${result.status}）${result.body}`);
      process.exitCode = 1;
    }
  }
  for (const file of source.files) {
    if (!pending.includes(file)) console.log(`  跳过 ${file.name}（已存在，用 --force 覆盖）`);
  }
  if (pending.length === 0) console.log('  没有需要上传的文件');

  /* ---- verify ----------------------------------------------------------- */
  const after = await listAllAttachments(options, gitee.password);
  const attachments = after.find((entry) => entry.release.id === release.id)?.attachments ?? [];
  console.log(`\nGitee 发行版现有 ${attachments.length} 个附件：`);
  for (const a of attachments) {
    console.log(
      `  - ${a.name.padEnd(42)} ${human(a.size).padStart(10)}  ` +
        `https://gitee.com/${options.owner}/${options.repo}/releases/download/${tag}/${a.name}`,
    );
  }
  console.log(`\n本次上传 ${uploaded} 个；发行版页面：https://gitee.com/${options.owner}/${options.repo}/releases/tag/${tag}`);
}

main().catch((error) => {
  console.error(`\n失败：${error.message}`);
  process.exitCode = 1;
});
