use std::net::TcpListener;
use std::time::Duration;

use tauri::{
    image::Image,
    menu::{MenuBuilder, MenuItem, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

const TRAY_ICON_ID: &str = "ziplyne-lens";
const TRAY_SUMMARY_PATH: &str = "/api/tray-summary";
const POLL_INTERVAL: Duration = Duration::from_secs(60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONSECUTIVE_FAILURES: u32 = 5;

struct ApiSidecar {
    child: std::sync::Mutex<Option<CommandChild>>,
    api_url: std::sync::Mutex<Option<String>>,
}

// Menu items whose text is refreshed on every tray-summary poll. Kept in
// managed state and cloned into the polling task.
#[derive(Clone)]
struct TrayStatusItems {
    best: MenuItem<tauri::Wry>,
    today: MenuItem<tauri::Wry>,
    attention: MenuItem<tauri::Wry>,
    connections: MenuItem<tauri::Wry>,
    agents: MenuItem<tauri::Wry>,
}

impl TrayStatusItems {
    fn build(app: &tauri::App) -> tauri::Result<Self> {
        Ok(Self {
            best: MenuItemBuilder::with_id("status-best", "Best: —")
                .enabled(false)
                .build(app)?,
            today: MenuItemBuilder::with_id("status-today", "Today: —")
                .enabled(false)
                .build(app)?,
            attention: MenuItemBuilder::with_id("status-attention", "Needs attention: —")
                .enabled(false)
                .build(app)?,
            connections: MenuItemBuilder::with_id("status-connections", "Connections: —")
                .enabled(false)
                .build(app)?,
            agents: MenuItemBuilder::with_id("status-agents", "Agents: —")
                .enabled(false)
                .build(app)?,
        })
    }
}

#[derive(serde::Serialize)]
struct DesktopStatus {
    menu_bar: bool,
    local_first: bool,
    api_url: Option<String>,
}

// Shape of GET /api/tray-summary on the API sidecar (see apps/api/src/limits.ts).
#[derive(serde::Deserialize)]
struct TraySummary {
    attention: TrayAttention,
    #[serde(default)]
    connections: TrayConnections,
    today: TrayToday,
    #[serde(rename = "bestAccount")]
    best_account: Option<TrayBestAccount>,
    #[serde(rename = "perAgent", default)]
    per_agent: Vec<TrayAgentUsage>,
}

#[derive(serde::Deserialize)]
struct TrayAttention {
    count: u64,
}

#[derive(serde::Deserialize, Default)]
struct TrayConnections {
    count: u64,
}

#[derive(serde::Deserialize)]
struct TrayToday {
    #[serde(rename = "costUsd")]
    cost_usd: f64,
    tokens: f64,
}

#[derive(serde::Deserialize)]
struct TrayBestAccount {
    label: String,
    #[serde(rename = "worstPct")]
    worst_pct: f64,
    severity: String,
}

#[derive(serde::Deserialize)]
struct TrayAgentUsage {
    source: String,
    #[serde(rename = "costUsd")]
    cost_usd: f64,
}

#[tauri::command]
fn desktop_status(state: tauri::State<'_, ApiSidecar>) -> DesktopStatus {
    DesktopStatus {
        menu_bar: true,
        local_first: true,
        api_url: state.api_url.lock().ok().and_then(|url| url.clone()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![desktop_status])
        .setup(|app| {
            app.manage(ApiSidecar {
                child: std::sync::Mutex::new(None),
                api_url: std::sync::Mutex::new(None),
            });
            start_api_sidecar(app);

            let status = TrayStatusItems::build(app)?;
            let open = MenuItemBuilder::with_id("open-dashboard", "Open Dashboard").build(app)?;
            let prompts = MenuItemBuilder::with_id("open-prompts", "Open Prompts").build(app)?;
            let pause = MenuItemBuilder::with_id("pause-indexing", "Pause Prompt Indexing")
                .enabled(false)
                .build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit ZipLyne Lens").build(app)?;
            let menu = MenuBuilder::new(app)
                .item(&status.best)
                .item(&status.today)
                .item(&status.attention)
                .item(&status.connections)
                .item(&status.agents)
                .separator()
                .item(&open)
                .item(&prompts)
                .item(&pause)
                .separator()
                .item(&quit_item)
                .build()?;

            TrayIconBuilder::with_id(TRAY_ICON_ID)
                .tooltip("ZipLyne Lens")
                .icon(tray_icon())
                .icon_as_template(true)
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open-dashboard" | "open-prompts" => show_dashboard(app),
                    "quit" => quit(app),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_dashboard(tray.app_handle());
                    }
                })
                .build(app)?;

            app.manage(status.clone());
            if let Some(api_url) = current_api_url(app) {
                start_tray_polling(app.handle(), api_url, status);
            } else {
                eprintln!("ZipLyne Lens tray summary polling disabled: no API URL.");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build ZipLyne Lens desktop app");

    app.run(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            stop_api_sidecar(app);
        }
    });
}

fn show_dashboard(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn start_api_sidecar(app: &tauri::App) {
    let Ok(command) = app.shell().sidecar("ziplyne-lens-api") else {
        eprintln!("ZipLyne Lens API sidecar is not available in this build.");
        return;
    };
    let Some(port) = available_loopback_port() else {
        eprintln!("ZipLyne Lens could not reserve a local API port.");
        return;
    };
    let api_url = format!("http://127.0.0.1:{port}");
    let Ok((mut rx, child)) = command.env("PORT", port.to_string()).spawn() else {
        eprintln!("ZipLyne Lens API sidecar could not be started.");
        return;
    };
    if let Some(state) = app.try_state::<ApiSidecar>() {
        let _ = state.child.lock().map(|mut slot| {
            *slot = Some(child);
        });
        let _ = state.api_url.lock().map(|mut slot| {
            *slot = Some(api_url.clone());
        });
    }
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            eprintln!("ZipLyne Lens API sidecar: {event:?}");
        }
    });
}

fn available_loopback_port() -> Option<u16> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).ok()?;
    listener.local_addr().ok().map(|address| address.port())
}

fn quit(app: &tauri::AppHandle) {
    stop_api_sidecar(app);
    app.exit(0);
}

fn stop_api_sidecar(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<ApiSidecar>() {
        if let Ok(mut slot) = state.child.lock() {
            if let Some(child) = slot.take() {
                let _ = child.kill();
            }
        }
    }
}

fn current_api_url(app: &tauri::App) -> Option<String> {
    app.try_state::<ApiSidecar>()
        .and_then(|state| state.api_url.lock().ok().and_then(|url| url.clone()))
}

// Polls the sidecar for tray status. Runs on the async runtime's blocking
// pool so neither the main thread nor async workers ever block; ureq is a
// blocking client, which is fine for one localhost GET per minute.
fn start_tray_polling(app: &tauri::AppHandle, api_url: String, items: TrayStatusItems) {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(REQUEST_TIMEOUT))
            .build()
            .into();
        let url = format!("{api_url}{TRAY_SUMMARY_PATH}");
        let mut consecutive_failures = 0_u32;
        loop {
            match fetch_tray_summary(&agent, &url) {
                Ok(summary) => {
                    consecutive_failures = 0;
                    apply_tray_summary(&handle, &items, &summary);
                }
                Err(error) => {
                    consecutive_failures += 1;
                    eprintln!("tray-summary poll failed ({consecutive_failures}): {error}");
                    if consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
                        apply_offline_state(&handle, &items);
                    }
                    // Otherwise keep showing the last good values.
                }
            }
            // While the sidecar is still booting the first poll usually fails;
            // retry quickly so the tray populates right away instead of a
            // minute later. Afterwards settle into the normal cadence.
            let interval = if consecutive_failures == 1 {
                std::time::Duration::from_secs(5)
            } else {
                POLL_INTERVAL
            };
            std::thread::sleep(interval);
        }
    });
}

fn fetch_tray_summary(agent: &ureq::Agent, url: &str) -> Result<TraySummary, String> {
    let mut response = agent.get(url).call().map_err(|error| error.to_string())?;
    response
        .body_mut()
        .read_json::<TraySummary>()
        .map_err(|error| error.to_string())
}

fn apply_tray_summary(app: &tauri::AppHandle, items: &TrayStatusItems, summary: &TraySummary) {
    let best_text = match &summary.best_account {
        Some(best) => format!("Best: {} {:.0}%", best.label, best.worst_pct),
        None => "Best: —".to_string(),
    };
    let _ = items.best.set_text(best_text);
    let _ = items.today.set_text(format!(
        "Today: {} · {} tok",
        format_usd(summary.today.cost_usd),
        format_tokens(summary.today.tokens)
    ));
    let _ = items
        .attention
        .set_text(format!("Needs attention: {}", summary.attention.count));
    let _ = items
        .connections
        .set_text(format!("Connections: {}", summary.connections.count));
    let _ = items.agents.set_text(format_agents(&summary.per_agent));

    if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(
            summary
                .best_account
                .as_ref()
                .map(|best| format!("● {:.0}%", best.worst_pct)),
        );
        // A colored badge can't be a template image (those render monochrome).
        let _ = tray.set_icon_as_template(false);
        let dot = summary
            .best_account
            .as_ref()
            .map(|best| severity_color(&best.severity))
            .unwrap_or(UNKNOWN_COLOR);
        let _ = tray.set_icon(Some(tray_icon_with_dot(dot)));
    }
}

fn apply_offline_state(app: &tauri::AppHandle, items: &TrayStatusItems) {
    let _ = items.best.set_text("API offline");
    let _ = items.today.set_text("Today: —");
    let _ = items.attention.set_text("Needs attention: —");
    let _ = items.connections.set_text("Connections: —");
    let _ = items.agents.set_text("Agents: —");
    if let Some(tray) = app.tray_by_id(TRAY_ICON_ID) {
        #[cfg(target_os = "macos")]
        let _ = tray.set_title(None::<&str>);
        let _ = tray.set_icon(Some(tray_icon()));
        let _ = tray.set_icon_as_template(true);
    }
}

const NORMAL_COLOR: (u8, u8, u8) = (52, 199, 89); // green
const WARNING_COLOR: (u8, u8, u8) = (224, 163, 0); // yellow, matches the API's #e0a300
const CRITICAL_COLOR: (u8, u8, u8) = (255, 59, 48); // red
const UNKNOWN_COLOR: (u8, u8, u8) = (142, 142, 147); // gray: API up, no account data

fn severity_color(severity: &str) -> (u8, u8, u8) {
    match severity {
        "critical" => CRITICAL_COLOR,
        "warning" => WARNING_COLOR,
        _ => NORMAL_COLOR,
    }
}

fn format_usd(value: f64) -> String {
    format!("${value:.2}")
}

fn format_tokens(tokens: f64) -> String {
    if tokens >= 1_000_000_000.0 {
        format!("{:.1}B", tokens / 1_000_000_000.0)
    } else if tokens >= 1_000_000.0 {
        format!("{:.1}M", tokens / 1_000_000.0)
    } else if tokens >= 1_000.0 {
        format!("{:.1}K", tokens / 1_000.0)
    } else {
        format!("{}", tokens.round() as u64)
    }
}

fn format_agents(per_agent: &[TrayAgentUsage]) -> String {
    if per_agent.is_empty() {
        return "Agents: —".to_string();
    }
    per_agent
        .iter()
        .map(|agent| format!("{} {}", agent.source, format_usd(agent.cost_usd)))
        .collect::<Vec<_>>()
        .join(" · ")
}

fn tray_icon() -> Image<'static> {
    tray_icon_pixels((0, 0, 0), None)
}

fn tray_icon_with_dot(dot: (u8, u8, u8)) -> Image<'static> {
    // Neutral gray glyph: the badge forces template mode off, and a pure black
    // glyph would vanish on a dark menu bar.
    tray_icon_pixels((120, 120, 120), Some(dot))
}

fn tray_icon_pixels(glyph: (u8, u8, u8), dot: Option<(u8, u8, u8)>) -> Image<'static> {
    let mut rgba = vec![0_u8; 18 * 18 * 4];
    let pixels: &[(usize, usize)] = &[
        (3, 3),
        (4, 3),
        (5, 3),
        (6, 3),
        (7, 3),
        (8, 3),
        (9, 3),
        (10, 3),
        (11, 3),
        (10, 4),
        (9, 5),
        (8, 6),
        (7, 7),
        (6, 8),
        (5, 9),
        (4, 10),
        (3, 11),
        (3, 12),
        (4, 12),
        (5, 12),
        (6, 12),
        (7, 12),
        (8, 12),
        (9, 12),
        (10, 12),
        (11, 12),
        (13, 3),
        (13, 4),
        (13, 5),
        (13, 6),
        (13, 7),
        (13, 8),
        (13, 9),
        (13, 10),
        (13, 11),
        (13, 12),
        (14, 12),
        (15, 12),
    ];
    for (x, y) in pixels {
        let index = ((y * 18) + x) * 4;
        rgba[index] = glyph.0;
        rgba[index + 1] = glyph.1;
        rgba[index + 2] = glyph.2;
        rgba[index + 3] = 255;
    }
    if let Some(color) = dot {
        // 5px badge in the bottom-right corner, below the glyph.
        let badge: &[(usize, usize)] = &[
            (14, 13),
            (13, 14),
            (14, 14),
            (15, 14),
            (12, 15),
            (13, 15),
            (14, 15),
            (15, 15),
            (16, 15),
            (13, 16),
            (14, 16),
            (15, 16),
            (14, 17),
        ];
        for (x, y) in badge {
            let index = ((y * 18) + x) * 4;
            rgba[index] = color.0;
            rgba[index + 1] = color.1;
            rgba[index + 2] = color.2;
            rgba[index + 3] = 255;
        }
    }
    Image::new_owned(rgba, 18, 18)
}
