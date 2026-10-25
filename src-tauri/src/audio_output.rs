//! Windows Core Audio endpoint-change notifications.
//!
//! The listener is event-driven: it does not poll. A change to the system's
//! default render endpoint is forwarded to the frontend, where the active
//! provider adapter can pause its current session.

use std::{
    sync::{Arc, Mutex},
    thread,
};

use tauri::{AppHandle, Emitter};
use windows::{
    core::{implement, PCWSTR},
    Win32::{
        Media::Audio::{
            eMultimedia, eRender, EDataFlow, ERole, IMMDeviceEnumerator, IMMNotificationClient,
            IMMNotificationClient_Impl, MMDeviceEnumerator, DEVICE_STATE, DEVICE_STATE_ACTIVE,
        },
        Foundation::PROPERTYKEY,
        System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
    },
};

const OUTPUT_CHANGE_EVENT: &str = "audio-output-changed";

#[derive(Clone)]
struct OutputListener {
    app: AppHandle,
    default_render_id: Arc<Mutex<Option<String>>>,
}

impl OutputListener {
    fn publish_change(&self) {
        let _ = self.app.emit(OUTPUT_CHANGE_EVENT, ());
    }

    fn update_default(&self, next: Option<String>) {
        let mut current = self.default_render_id.lock().unwrap_or_else(|error| error.into_inner());
        let changed = current.as_ref().is_some_and(|previous| Some(previous) != next.as_ref());
        *current = next;
        if changed {
            self.publish_change();
        }
    }
}

#[implement(IMMNotificationClient)]
struct CoreAudioNotification(OutputListener);

impl IMMNotificationClient_Impl for CoreAudioNotification_Impl {
    fn OnDeviceStateChanged(&self, device_id: &PCWSTR, new_state: DEVICE_STATE) -> windows::core::Result<()> {
        if device_id.is_null() || new_state == DEVICE_STATE_ACTIVE {
            return Ok(());
        }
        let changed_id = match unsafe { device_id.to_string() } {
            Ok(id) => id,
            Err(_) => return Ok(()),
        };
        let current_id = self.0.default_render_id.lock().unwrap_or_else(|error| error.into_inner()).clone();
        // Only react to loss of the output Viviette was following. Input-device
        // state changes and unrelated outputs do not affect this playback path.
        if current_id.as_deref() == Some(changed_id.as_str()) {
            self.0.update_default(None);
        }
        Ok(())
    }

    fn OnDeviceAdded(&self, _device_id: &PCWSTR) -> windows::core::Result<()> { Ok(()) }

    fn OnDeviceRemoved(&self, device_id: &PCWSTR) -> windows::core::Result<()> {
        if device_id.is_null() {
            return Ok(());
        }
        let removed_id = match unsafe { device_id.to_string() } {
            Ok(id) => id,
            Err(_) => return Ok(()),
        };
        let current_id = self.0.default_render_id.lock().unwrap_or_else(|error| error.into_inner()).clone();
        if current_id.as_deref() == Some(removed_id.as_str()) {
            self.0.update_default(None);
        }
        Ok(())
    }

    fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, device_id: &PCWSTR) -> windows::core::Result<()> {
        if flow != eRender || role != eMultimedia {
            return Ok(());
        }
        let next = if device_id.is_null() { None } else { unsafe { device_id.to_string().ok() } };
        self.0.update_default(next);
        Ok(())
    }

    fn OnPropertyValueChanged(&self, _device_id: &PCWSTR, _key: &PROPERTYKEY) -> windows::core::Result<()> { Ok(()) }
}

pub fn start(app: AppHandle) {
    let result = thread::Builder::new()
        .name("viviette-audio-output-events".into())
        .spawn(move || {
            if let Err(error) = run(app) {
                eprintln!("Viviette audio-output monitor unavailable: {error}");
            }
        });
    if let Err(error) = result {
        eprintln!("Viviette could not start audio-output monitor: {error}");
    }
}

fn run(app: AppHandle) -> windows::core::Result<()> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    let enumerator: IMMDeviceEnumerator = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)? };
    let initial_id = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia) }
        .ok()
        .and_then(|device| unsafe { device.GetId().ok() })
        .and_then(|id| unsafe { id.to_string().ok() });
    let callback = CoreAudioNotification(OutputListener {
        app,
        default_render_id: Arc::new(Mutex::new(initial_id)),
    });
    let interface: IMMNotificationClient = callback.into();
    unsafe { enumerator.RegisterEndpointNotificationCallback(&interface)? };

    // Core Audio invokes callbacks as device events arrive. Keep the COM
    // enumerator and callback alive for this thread's lifetime without polling.
    loop {
        thread::park();
    }
}
