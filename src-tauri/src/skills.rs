//! 技能广场：扫描 / 安装 / 删除 dsh 的 skills 与专家（agent presets）。
//!
//! 数据主要来自文件系统与远程技能广场（skillhub.cn API / 旧版 skillshub index.json）：
//! - 我的 skills：`<dshHome>/skills`（`<name>/SKILL.md` 或平铺 `<name>.md`）
//! - 我的专家：`<dshHome>/.agent-presets`（每个子目录一个 preset：agent.cordis.yml + preset.yml）
//! - 技能广场 / 专家广场：远程技能广场索引（列出可安装的技能/专家及其 zip 下载链接）。
//!   专家广场不再展示随附（内置）专家，只列数据源提供 + 用户已安装的。

use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::hub::{extract_zip_strip_root, fetch_skillshub, install_remote_zip, urlencode};
use crate::state::{dsh_home, find_dsh_package_dir, AppState};

/// 单个技能条目（wire 投影）。
#[derive(Serialize, Clone)]
pub struct SkillInfo {
    pub name: String,
    /// 展示用名称（skillhub.cn 提供中文名）；无则用 name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub description: String,
    pub when_to_use: Option<String>,
    /// "user"（我的）| "hub"（技能广场）| "bundled"（随附兜底）
    pub source: String,
    /// 来源说明（用户目录或数据源名，如 skillhub.cn / skillshub）
    pub origin: String,
    /// 是否已安装到用户技能目录（广场条目才关心）
    pub installed: bool,
    /// 远程下载地址（数据源提供）；本地随附技能为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// 单个专家（agent preset）条目。
#[derive(Serialize, Clone)]
pub struct ExpertInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    /// "user"（本地）| "hub"（skillshub）
    pub trust: String,
    /// 该专家捆绑的技能列表
    pub skills: Vec<String>,
    /// 是否已安装到用户专家目录
    pub installed: bool,
    /// 远程下载地址（skillshub 提供）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Serialize)]
pub struct SkillsView {
    pub skills: Vec<SkillInfo>,
    pub experts: Vec<ExpertInfo>,
    /// skillshub 拉取失败时的提示（仅技能/专家广场有）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 本地导入的单个文件（前端选择 zip/文件夹后回传）。
#[derive(serde::Deserialize)]
pub struct ImportedFile {
    /// 相对路径，如 "SKILL.md" 或 "src/index.ts"
    pub path: String,
    /// 文件内容（字节）
    pub content: Vec<u8>,
}

// ---------- 路径 ----------

/// 用户技能根目录 `<dshHome>/skills`
fn user_skills_dir() -> PathBuf {
    dsh_home().join("skills")
}

/// 用户专家根目录 `<dshHome>/.agent-presets`
fn user_experts_dir() -> PathBuf {
    dsh_home().join(".agent-presets")
}

/// dsh 官方包随附 preset 根目录 `<dshpkg>/config/agent-presets`
fn bundled_presets_dir() -> Option<PathBuf> {
    find_dsh_package_dir().map(|p| p.join("config").join("agent-presets"))
}

// ---------- frontmatter 解析（轻量 YAML：仅取 name/description/whenToUse） ----------

/// 从 `---\nkey: value\n---` 块里取单行值；引号与行尾注释一并清理。
fn frontmatter_field(block: &str, key: &str) -> Option<String> {
    for line in block.lines() {
        let line = line.trim();
        let Some((k, v)) = line.split_once(':') else { continue };
        if k.trim() != key {
            continue;
        }
        let mut val = v.trim().to_string();
        // 去掉 YAML 行内注释（# 前需有空白）
        if let Some(idx) = val.find(" #") {
            val.truncate(idx);
        }
        let val = val.trim().to_string();
        // 去掉成对引号
        let val = val
            .strip_prefix('"')
            .and_then(|s| s.strip_suffix('"'))
            .or_else(|| {
                val.strip_prefix('\'').and_then(|s| s.strip_suffix('\''))
            })
            .map(|s| s.to_string())
            .unwrap_or(val);
        if !val.is_empty() {
            return Some(val);
        }
    }
    None
}

/// 解析 Markdown frontmatter，返回 (name, description, when_to_use)。
fn parse_md_frontmatter(text: &str) -> (Option<String>, Option<String>, Option<String>) {
    let body = text.trim_start_matches('\u{feff}').trim_start();
    let rest = match body.strip_prefix("---") {
        Some(r) => r,
        None => return (None, None, None),
    };
    let end = rest.find("\n---").or_else(|| rest.find("\n..."));
    let block = match end {
        Some(i) => &rest[..i],
        None => return (None, None, None),
    };
    (
        frontmatter_field(block, "name"),
        frontmatter_field(block, "description"),
        frontmatter_field(block, "whenToUse"),
    )
}

/// 解析 preset.yml 的展示元信息，返回 (name, description)。
fn parse_preset_yml(text: &str) -> (Option<String>, Option<String>) {
    let (name, desc, _) = parse_md_frontmatter(text);
    // preset.yml 无 frontmatter 块时按普通 key: value 行解析
    if name.is_some() || desc.is_some() {
        return (name, desc);
    }
    let mut name = None;
    let mut desc = None;
    for line in text.lines() {
        let line = line.trim();
        if name.is_none() {
            if let Some((k, v)) = line.split_once(':') {
                if k.trim() == "name" {
                    name = Some(v.trim().to_string());
                    continue;
                }
            }
        }
        if desc.is_none() {
            if let Some((k, v)) = line.split_once(':') {
                if k.trim() == "description" {
                    desc = Some(v.trim().to_string());
                }
            }
        }
    }
    (name.filter(|s| !s.is_empty()), desc.filter(|s| !s.is_empty()))
}

// ---------- skill 目录扫描 ----------

/// 扫描一个技能根目录：识别 `<name>/SKILL.md` 与平铺 `<name>.md`。
fn scan_skill_root(
    root: &Path,
    source: &str,
    origin: &str,
    installed: &HashSet<String>,
) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let read = match fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for entry in read.flatten() {
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name == ".system" {
            continue;
        }
        if path.is_dir() {
            let skill_file = path.join("SKILL.md");
            if skill_file.is_file() {
                if let Ok(text) = fs::read_to_string(&skill_file) {
                    let (name, desc, when) = parse_md_frontmatter(&text);
                    let name = name.filter(|n| !n.trim().is_empty());
                    if let Some(name) = name {
                        out.push(SkillInfo {
                            name: name.trim().to_string(),
                            display_name: None,
                            description: desc.unwrap_or_default().trim().to_string(),
                            when_to_use: when.map(|w| w.trim().to_string()),
                            source: source.to_string(),
                            origin: origin.to_string(),
                            installed: installed.contains(&name.trim().to_string()),
                            url: None,
                        });
                    }
                }
            }
        } else if file_name.to_lowercase().ends_with(".md") {
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if let Ok(text) = fs::read_to_string(&path) {
                let (name, desc, when) = parse_md_frontmatter(&text);
                let name = name
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| stem.clone());
                out.push(SkillInfo {
                    name: name.trim().to_string(),
                    display_name: None,
                    description: desc.unwrap_or_default().trim().to_string(),
                    when_to_use: when.map(|w| w.trim().to_string()),
                    source: source.to_string(),
                    origin: origin.to_string(),
                    installed: installed.contains(&name.trim().to_string()),
                    url: None,
                });
            }
        }
    }
    out
}

/// 已有 skill 名集合（用于判断广场条目是否已安装）。
fn installed_skill_names() -> HashSet<String> {
    let mut set = HashSet::new();
    let root = user_skills_dir();
    if let Ok(read) = fs::read_dir(&root) {
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name != ".system" {
                set.insert(name);
            }
        }
    }
    set
}

/// 已有专家 id 集合。
fn installed_expert_ids() -> HashSet<String> {
    let mut set = HashSet::new();
    if let Ok(read) = fs::read_dir(user_experts_dir()) {
        for entry in read.flatten() {
            set.insert(entry.file_name().to_string_lossy().to_string());
        }
    }
    set
}

// ---------- preset 扫描 ----------

/// 扫描一个 preset 根目录，返回专家条目。
fn scan_preset_root(root: &Path, trust: &str, installed: &HashSet<String>) -> Vec<ExpertInfo> {
    let mut out = Vec::new();
    let read = match fs::read_dir(root) {
        Ok(r) => r,
        Err(_) => return out,
    };
    for entry in read.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if !dir.join("agent.cordis.yml").is_file() {
            continue;
        }
        let (mut name, description) = {
            let yml = dir.join("preset.yml");
            if yml.is_file() {
                if let Ok(text) = fs::read_to_string(&yml) {
                    parse_preset_yml(&text)
                } else {
                    (None, None)
                }
            } else {
                (None, None)
            }
        };
        if name.is_none() || name.as_deref() == Some(id.as_str()) {
            name = Some(id.clone());
        }
        // 捆绑的技能：preset 目录下 skills/ 的子目录名
        let mut skills = Vec::new();
        let skills_root = dir.join("skills");
        if let Ok(read) = fs::read_dir(&skills_root) {
            for s in read.flatten() {
                let sname = s.file_name().to_string_lossy().to_string();
                if s.path().is_dir() {
                    skills.push(sname);
                }
            }
        }
        skills.sort();
        let installed_flag = installed.contains(&id);
        out.push(ExpertInfo {
            id,
            name: name.unwrap_or_default(),
            description: description.unwrap_or_default(),
            trust: trust.to_string(),
            skills,
            installed: installed_flag,
            url: None,
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

// ---------- 命令 ----------

/// 我的技能：用户 skills + 用户专家。
#[tauri::command]
pub fn list_my_skills() -> SkillsView {
    let skills = {
        let installed = installed_skill_names();
        scan_skill_root(&user_skills_dir(), "user", "本地用户技能", &installed)
    };
    let experts = {
        let installed = installed_expert_ids();
        scan_preset_root(&user_experts_dir(), "user", &installed)
    };
    SkillsView {
        skills,
        experts,
        error: None,
    }
}

/// 技能广场 / 专家广场：从技能广场数据源拉取可安装集合（带已安装标记）。
/// `keyword` 非空时，对 skillhub.cn 官方 API 执行服务端关键词搜索；其余数据源忽略关键词。
/// 数据源不可用时返回空集 + error 提示；不再展示随附（内置）专家。
#[tauri::command]
pub async fn list_skill_plaza(
    state: State<'_, AppState>,
    keyword: Option<String>,
) -> Result<SkillsView, String> {
    let mut url = state
        .settings
        .lock()
        .map(|s| s.skillshub_url.clone())
        .unwrap_or_default();
    let kw = keyword.unwrap_or_default().trim().to_string();
    // skillhub.cn 官方 API 支持 keyword 服务端分词搜索；其他数据源（旧 index.json）忽略关键词
    if !kw.is_empty() && url.contains("api.skillhub.cn") {
        url = format!(
            "https://api.skillhub.cn/api/skills?keyword={}&sortBy=score&pageSize=50",
            urlencode(&kw)
        );
    }

    let installed_skills = installed_skill_names();
    let installed_experts = installed_expert_ids();

    let index = match tauri::async_runtime::spawn_blocking(move || fetch_skillshub(&url)).await {
        Ok(Ok(idx)) => idx,
        Ok(Err(e)) => {
            return Ok(SkillsView {
                skills: Vec::new(),
                experts: Vec::new(),
                error: Some(format!("无法连接技能广场数据源：{}", e)),
            });
        }
        Err(e) => {
            return Ok(SkillsView {
                skills: Vec::new(),
                experts: Vec::new(),
                error: Some(format!("加载异常：{}", e)),
            });
        }
    };
    let origin = if index.origin.is_empty() {
        "技能广场".to_string()
    } else {
        index.origin.clone()
    };

    let mut skills: Vec<SkillInfo> = index
        .skills
        .into_iter()
        .map(|s| SkillInfo {
            installed: installed_skills.contains(&s.name),
            url: s.url.clone(),
            name: s.name,
            display_name: s.display_name,
            description: s.description,
            when_to_use: s.when_to_use,
            source: "hub".into(),
            origin: origin.clone(),
        })
        .collect();
    skills.sort_by(|a, b| a.name.cmp(&b.name));

    let mut experts: Vec<ExpertInfo> = index
        .experts
        .into_iter()
        .map(|e| ExpertInfo {
            installed: installed_experts.contains(&e.id),
            url: e.url.clone(),
            id: e.id,
            name: e.name,
            description: e.description,
            trust: "hub".into(),
            skills: e.skills,
        })
        .collect();
    experts.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(SkillsView {
        skills,
        experts,
        error: None,
    })
}

// ---------- 安装 / 删除 ----------

/// id/name 必须是安全的目录名（禁止路径分隔符等）。
fn safe_segment(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains(':')
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Err(format!("源目录不存在: {}", src.display()));
    }
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let s = entry.path();
        let d = dst.join(entry.file_name());
        if s.is_dir() {
            copy_dir(&s, &d)?;
        } else {
            fs::copy(&s, &d).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn remove_dir_checked(target: &Path) -> Result<(), String> {
    if !target.exists() {
        return Err("目标不存在".into());
    }
    fs::remove_dir_all(target).map_err(|e| e.to_string())
}

/// 在随附 preset 集合中按 name 定位一个技能目录。
fn find_bundled_skill(name: &str) -> Option<PathBuf> {
    let presets_root = bundled_presets_dir()?;
    let read = fs::read_dir(&presets_root).ok()?;
    for entry in read.flatten() {
        let skills_root = entry.path().join("skills");
        let cand = skills_root.join(name);
        if cand.join("SKILL.md").is_file() {
            return Some(cand);
        }
        // 平铺技能
        let flat = skills_root.join(format!("{}.md", name));
        if flat.is_file() {
            return Some(flat);
        }
    }
    None
}

/// 安装一个广场技能到用户技能目录。
/// 若提供 `url`（数据源给出），则从远程 zip 下载解压；否则从随附 preset 复制。
#[tauri::command]
pub async fn install_skill(name: String, url: Option<String>) -> Result<(), String> {
    if !safe_segment(&name) {
        return Err("非法的技能名称".into());
    }
    let dst = user_skills_dir().join(&name);
    if dst.exists() {
        return Err(format!("技能已安装: {}", name));
    }

    if let Some(url) = url {
        let url = url.trim().to_string();
        if url.is_empty() {
            return Err("技能缺少下载地址".into());
        }
        let name_for_task = name.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            install_remote_zip(&url, &user_skills_dir().join(&name_for_task))
        })
        .await
        .map_err(|e| format!("线程异常: {}", e))?;
    }

    // 兜底：从随附 preset 复制
    let src = find_bundled_skill(&name).ok_or_else(|| format!("广场中未找到技能: {}", name))?;
    fs::create_dir_all(&user_skills_dir()).map_err(|e| e.to_string())?;
    if src.is_dir() {
        copy_dir(&src, &dst)
    } else {
        fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// 安装一个广场专家（preset）到用户专家目录。
/// 若提供 `url`（数据源给出），则从远程 zip 下载解压；否则从随附 preset 复制。
#[tauri::command]
pub async fn install_expert(id: String, url: Option<String>) -> Result<(), String> {
    if !safe_segment(&id) {
        return Err("非法的专家 id".into());
    }
    let dst = user_experts_dir().join(&id);
    if dst.exists() {
        return Err(format!("专家已存在: {}", id));
    }

    if let Some(url) = url {
        let url = url.trim().to_string();
        if url.is_empty() {
            return Err("专家缺少下载地址".into());
        }
        let id_for_task = id.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            install_remote_zip(&url, &user_experts_dir().join(&id_for_task))
        })
        .await
        .map_err(|e| format!("线程异常: {}", e))?;
    }

    // 兜底：从随附 preset 复制
    let presets_root = bundled_presets_dir()
        .ok_or_else(|| "未找到 dsh 运行时，请先部署".to_string())?;
    let src = presets_root.join(&id);
    if !src.join("agent.cordis.yml").is_file() {
        return Err(format!("广场中未找到专家: {}", id));
    }
    fs::create_dir_all(&user_experts_dir()).map_err(|e| e.to_string())?;
    copy_dir(&src, &dst)
}

/// 删除我的技能（仅用户技能目录）。
#[tauri::command]
pub fn remove_skill(name: String) -> Result<(), String> {
    if !safe_segment(&name) {
        return Err("非法的技能名称".into());
    }
    let target = user_skills_dir().join(&name);
    if target.join("SKILL.md").is_file() {
        return remove_dir_checked(&target);
    }
    let flat = user_skills_dir().join(format!("{}.md", name));
    if flat.is_file() {
        return fs::remove_file(&flat).map_err(|e| e.to_string());
    }
    if target.exists() {
        return remove_dir_checked(&target);
    }
    Err(format!("技能不存在: {}", name))
}

/// 删除我的专家（仅用户专家目录）。
#[tauri::command]
pub fn remove_expert(id: String) -> Result<(), String> {
    if !safe_segment(&id) {
        return Err("非法的专家 id".into());
    }
    let target = user_experts_dir().join(&id);
    if !target.is_dir() {
        return Err(format!("专家不存在: {}", id));
    }
    // 只允许删除用户目录下的（随附 preset 在 npx 缓存里，永远不该被删）
    remove_dir_checked(&target)
}

// ---------- 本地导入（zip / 文件夹） ----------

/// 相对路径安全校验：仅允许普通相对路径，拒绝 `..`、绝对路径、盘符等。
fn safe_relative_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);
    if p.is_absolute() || p.as_os_str().is_empty() {
        return Err(format!("非法文件路径: {}", path));
    }
    let mut out = std::path::PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::Normal(s) => out.push(s),
            _ => return Err(format!("非法文件路径: {}", path)),
        }
    }
    if out.as_os_str().is_empty() {
        return Err(format!("非法文件路径: {}", path));
    }
    Ok(out)
}

/// 导入一个技能 zip（前端上传字节）到用户技能目录 `<dshHome>/skills/<name>/`。
#[tauri::command]
pub async fn import_skill_zip(name: String, bytes: Vec<u8>) -> Result<(), String> {
    if !safe_segment(&name) {
        return Err("非法的技能名称".into());
    }
    if bytes.is_empty() {
        return Err("导入内容为空".into());
    }
    let dst = user_skills_dir().join(&name);
    if dst.exists() {
        return Err(format!("技能已存在: {}", name));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let tmp = std::env::temp_dir().join(format!("dsh-import-skill-{}.zip", name));
        std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
        let result = std::fs::create_dir_all(&dst)
            .map_err(|e| e.to_string())
            .and_then(|_| extract_zip_strip_root(&tmp, &dst));
        let _ = std::fs::remove_file(&tmp);
        if result.is_err() {
            let _ = std::fs::remove_dir_all(&dst);
        }
        result
    })
    .await
    .map_err(|e| format!("线程异常: {}", e))?
}

/// 导入一个技能文件夹（前端遍历文件后回传）到用户技能目录 `<dshHome>/skills/<name>/`。
#[tauri::command]
pub async fn import_skill_dir(name: String, files: Vec<ImportedFile>) -> Result<(), String> {
    if !safe_segment(&name) {
        return Err("非法的技能名称".into());
    }
    if files.is_empty() {
        return Err("未选择任何文件".into());
    }
    let dst = user_skills_dir().join(&name);
    if dst.exists() {
        return Err(format!("技能已存在: {}", name));
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
        for f in files {
            let rel = safe_relative_path(&f.path)?;
            let full = dst.join(&rel);
            if let Some(p) = full.parent() {
                std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
            }
            std::fs::write(&full, &f.content).map_err(|e| format!("写入 {} 失败: {}", f.path, e))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("线程异常: {}", e))?
}
