// 防止 Windows release 版本多弹一个控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "gui")]

fn main() {
    omp_desktop_lib::run()
}
