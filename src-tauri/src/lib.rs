mod commands;
mod deploy;
mod download;
mod hub;
mod plugins;
mod process;
mod service;
mod skills;
mod state;
mod update;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .setup(|app| {
            // 启动时加载持久化设置，并确保数据目录存在
            let loaded = state::load_settings();
            *app.state::<AppState>().settings.lock().unwrap() = loaded;
            let _ = std::fs::create_dir_all(state::data_dir());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_status,
            commands::deploy,
            commands::start_service,
            commands::stop_service,
            commands::open_browser,
            commands::get_settings,
            commands::set_settings,
            commands::check_update,
            commands::list_releases,
            commands::download_update,
            commands::open_file,
            plugins::list_builtin_plugins,
            plugins::set_builtin_plugin_enabled,
            plugins::ensure_builtin_plugins_default_enabled,
            plugins::list_external_plugins,
            plugins::add_external_plugin,
            plugins::remove_external_plugin,
            plugins::install_external_plugin,
            plugins::import_plugin_zip,
            plugins::import_plugin_dir,
            hub::search_remote_plugins,
            hub::install_remote_plugin,
            skills::list_my_skills,
            skills::list_skill_plaza,
            skills::install_skill,
            skills::install_expert,
            skills::remove_skill,
            skills::remove_expert,
            skills::import_skill_zip,
            skills::import_skill_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            let st = app_handle.state::<AppState>();
            let stop = st.settings.lock().unwrap().stop_on_exit;
            if stop {
                service::stop_on_exit(st.inner());
            }
        }
    });
}
