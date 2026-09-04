import os
import sys
import time
import json
import urllib.parse
from DrissionPage import ChromiumPage, ChromiumOptions

def get_xvfb_display():
    if "DISPLAY" in os.environ and os.environ["DISPLAY"]:
        return os.environ["DISPLAY"]
    try:
        import subprocess
        output = subprocess.check_output("ps aux | grep -i '[X]vfb :'", shell=True).decode()
        for part in output.split():
            if part.startswith(":"):
                return part
    except Exception:
        pass
    return ":307825218"

def refresh_mkvbase_session(save_path="/root/sudoaddon/.mkvbase_profile/session.json"):
    display = get_xvfb_display()
    os.environ["DISPLAY"] = display

    co = ChromiumOptions()
    co.set_argument("--no-sandbox")
    co.set_argument("--disable-blink-features=AutomationControlled")
    co.set_argument("--disable-web-security")
    co.set_argument("--disable-features=IsolateOrigins,site-per-process")

    driver = None
    try:
        driver = ChromiumPage(co)
        driver.get("https://mkvbase.site/")
        
        session = None
        for _ in range(10):
            time.sleep(1)
            cookies = driver.cookies()
            cookie_dict = {c["name"]: c["value"] for c in cookies}
            if "mkv_client_key" in cookie_dict and "mkv_challenge" in cookie_dict:
                ua = driver.user_agent
                raw_challenge = cookie_dict.get("mkv_challenge", "")
                decoded_challenge = urllib.parse.unquote(raw_challenge)
                
                cookie_header = "; ".join([f"{c['name']}={c['value']}" for c in cookies])
                session = {
                    "cookieHeader": cookie_header,
                    "userAgent": ua,
                    "clientKey": cookie_dict.get("mkv_client_key"),
                    "challenge": decoded_challenge,
                    "seq": cookie_dict.get("mkv_seq", "1"),
                    "savedAt": int(time.time() * 1000)
                }
                break

        if session and session.get("clientKey") and session.get("challenge"):
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            with open(save_path, "w") as f:
                json.dump(session, f, indent=2)
            print(f"[MkvBase Session] Saved valid session to {save_path} (clientKey: {session['clientKey'][:12]}...)")
            return 0
        else:
            print("[MkvBase Session] Failed to obtain valid cookies from mkvbase.site", file=sys.stderr)
            return 1
    except Exception as e:
        print(f"[MkvBase Session] Error during session refresh: {e}", file=sys.stderr)
        return 1
    finally:
        if driver:
            try:
                driver.quit()
            except Exception:
                pass

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "/root/sudoaddon/.mkvbase_profile/session.json"
    sys.exit(refresh_mkvbase_session(target))
