//! Asks Windows whether the user's session is locked (Win+L, lock screen, screen timeout).
//! Polling works without a window message hook, so it also runs while the window is hidden.

use std::{ffi::c_void, ptr};
use windows_sys::Win32::System::RemoteDesktop::{
    WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
    WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
};

/// `WTS_SESSIONSTATE_LOCK` in the session flags. Windows 7 had this value reversed.
const SESSION_FLAG_LOCKED: i32 = 0;

/// Returns `None` when Windows cannot answer.
pub fn is_locked() -> Option<bool> {
    let mut buffer = ptr::null_mut::<u16>();
    let mut size = 0u32;
    // SAFETY: both out pointers are valid for the call, and the handle and session
    // constants are the documented values for "this computer, this session".
    let ok = unsafe {
        WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut size,
        )
    };
    if ok == 0 || buffer.is_null() {
        return None;
    }
    let long_enough = size as usize >= std::mem::size_of::<WTSINFOEXW>();
    // SAFETY: on success `buffer` points to `size` bytes holding a WTSINFOEXW, checked
    // above, and Level 1 is the only union variant Windows defines.
    let flags = long_enough.then(|| unsafe {
        let info = &*(buffer as *const WTSINFOEXW);
        (info.Level == 1).then_some(info.Data.WTSInfoExLevel1.SessionFlags)
    });
    // SAFETY: `buffer` was allocated by the WTS call above and is not used afterwards.
    unsafe { WTSFreeMemory(buffer as *mut c_void) };
    flags.flatten().map(|flags| flags == SESSION_FLAG_LOCKED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_reports_the_running_session_as_unlocked() {
        assert_eq!(is_locked(), Some(false));
    }
}
