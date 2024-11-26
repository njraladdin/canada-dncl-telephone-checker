from DrissionPage import Chromium, ChromiumOptions
import time
import random
import requests
import os
import sys
from urllib.parse import urlparse
import json
from dotenv import load_dotenv
import pathlib
import threading
from queue import Queue
from dataclasses import dataclass, field
from typing import List, Callable
from datetime import datetime
import asyncio
from twocaptcha import TwoCaptcha

# Configuration Constants
CHROME_PATHS = {
    'win32': "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    'linux': "/usr/bin/google-chrome"
}

@dataclass
class ResultState:
    successful: List[str] = field(default_factory=list)  # Store successful tokens
    failed: List[datetime] = field(default_factory=list)  # Store failed attempt timestamps
    total_attempts: int = 0
    
    @property
    def success_rate(self) -> float:
        if self.total_attempts == 0:
            return 0.0
        return (len(self.successful) / self.total_attempts) * 100
    
    def print_progress(self):
        print(f"\n=== PROGRESS UPDATE (Completed: {self.total_attempts}) ===")
        print(f"Success rate: {self.success_rate:.1f}%")
        print(f"Total successful tokens: {len(self.successful)}")
        print(f"Failed attempts: {len(self.failed)}")
        print("=" * 50)

class CaptchaTokenExtractor:
    def __init__(self, tabs_per_browser=6, headless=False, on_token_found=None):
        self.tabs_per_browser = tabs_per_browser
        self.headless = headless
        self.results = ResultState()
        self.on_token_found = on_token_found
        self.solver = TwoCaptcha(os.getenv('2CAPTCHA_API_KEY'))  # Initialize 2captcha solver with API key from .env
        
        # Load environment variables
        load_dotenv()

    async def _handle_token_found(self, token: str):
        """Async wrapper for token found callback"""
        if self.on_token_found:
            if asyncio.iscoroutinefunction(self.on_token_found):
                await self.on_token_found(token)
            else:
                self.on_token_found(token)

    def get_chrome_path(self):
        """Get the appropriate Chrome executable path for the current platform"""
        platform = sys.platform
        chrome_path = CHROME_PATHS.get(platform)
        
        if not chrome_path:
            raise RuntimeError(f"Unsupported platform: {platform}")
        
        if not os.path.exists(chrome_path):
            raise RuntimeError(f"Chrome executable not found at: {chrome_path}")
        
        return chrome_path

    def get_chrome_options(self):
        """Create ChromiumOptions with random user data directory"""
        co = ChromiumOptions()
        
        # Set Chrome executable path
        try:
            chrome_path = self.get_chrome_path()
            co.set_browser_path(chrome_path)
            print(f"Using Chrome at: {chrome_path}")
        except Exception as e:
            print(f"Warning: Failed to set Chrome path: {str(e)}")
        
        # Set headless mode
        co.headless(self.headless)

        # # Add proxy extension
        # proxy_extension_path = os.path.join(os.path.dirname(__file__), 'proxies_extension')
        # if os.path.exists(proxy_extension_path):
        #     co.add_extension(proxy_extension_path)
        #     print(f"Added proxy extension from: {proxy_extension_path}")
        # else:
        #     print(f"Warning: Proxy extension not found at {proxy_extension_path}")
        
        # Create base chrome-data directory if it doesn't exist
        base_dir = pathlib.Path('chrome-data')
        base_dir.mkdir(exist_ok=True)
        
        # Choose random profile number
        profile_num = random.randint(1, 10)
        user_data_dir = base_dir / f'chrome-data-{profile_num}'
        user_data_dir.mkdir(exist_ok=True)
        
        # Set user data directory
        co.set_user_data_path(str(user_data_dir))
        
        # Add all Chrome flags
        chrome_flags = [
            '--no-sandbox',
            '--disable-gpu',
            '--enable-webgl',
            '--window-size=1920,1080',
            '--disable-dev-shm-usage',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--flag-switches-begin',
            '--disable-site-isolation-trials',
            '--flag-switches-end',
            f'--profile-directory=Profile {profile_num}'
        ]
        
        for flag in chrome_flags:
            co.set_argument(flag)
        
        # Set preferences to avoid automation detection
        co.set_pref('excludeSwitches', ['enable-automation'])
        co.set_pref('useAutomationExtension', False)
        
        return co

    def random_delay(self, min_ms=10, max_ms=50):
        delay = random.randint(min_ms, max_ms) / 1000.0
        time.sleep(delay)

    def wait_for_recaptcha_frame(self, tab, timeout=10):
        """Wait for reCAPTCHA frame to be fully loaded"""
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                js_check = """
                    const frames = document.getElementsByTagName('iframe');
                    for (let frame of frames) {
                        if (frame.src && frame.src.includes('recaptcha')) {
                            const rect = frame.getBoundingClientRect();
                            if (rect.height > 0) {
                                return {
                                    found: true,
                                    name: frame.name,
                                    src: frame.src,
                                    height: rect.height
                                };
                            }
                        }
                    }
                    return { found: false };
                """
                result = tab.run_js(js_check)
                if result.get('found'):
                    print(f"Found loaded reCAPTCHA frame with height: {result.get('height')}")
                    return result
                time.sleep(0.2)
            except Exception as e:
                print(f"Error checking frame: {str(e)}")
                time.sleep(0.2)
        return None

    def solve_captcha_with_2captcha(self, tab):
        """Solve reCAPTCHA using 2captcha service"""
        try:
            print("Getting reCAPTCHA parameters...")
            
            # First try to get sitekey from data-sitekey attribute
            js_get_sitekey = """
                const elements = document.querySelectorAll('[data-sitekey]');
                console.log('Elements with data-sitekey:', elements);
                return elements.length > 0 ? elements[0].getAttribute('data-sitekey') : null;
            """
            sitekey = tab.run_js(js_get_sitekey)
            print(f"Attempt 1 - data-sitekey search result: {sitekey}")
            
            if not sitekey:
                print("Trying to extract sitekey from iframe src...")
                js_get_iframe_src = """
                    const frames = document.getElementsByTagName('iframe');
                    for (let frame of frames) {
                        console.log('Frame src:', frame.src);
                        if (frame.src && frame.src.includes('recaptcha')) {
                            return frame.src;
                        }
                    }
                    return null;
                """
                iframe_src = tab.run_js(js_get_iframe_src)
                print(f"Found iframe src: {iframe_src}")
                
                if iframe_src:
                    # Extract sitekey from URL parameters
                    import re
                    sitekey_match = re.search(r'[?&]k=([^&]+)', iframe_src)
                    if sitekey_match:
                        sitekey = sitekey_match.group(1)
                        print(f"Successfully extracted sitekey from iframe: {sitekey}")
                    else:
                        print("Could not find sitekey in iframe src")
            
            if not sitekey:
                print("Failed to find reCAPTCHA sitekey")
                # Debug: Print all iframes for inspection
                js_debug_iframes = """
                    const frames = document.getElementsByTagName('iframe');
                    return Array.from(frames).map(f => ({
                        src: f.src,
                        id: f.id,
                        name: f.name,
                        className: f.className
                    }));
                """
                iframes = tab.run_js(js_debug_iframes)
                print("All iframes found:")
                for iframe in iframes:
                    print(f"  - {iframe}")
                return None
                
            print(f"Found sitekey: {sitekey}")
            
            # Get the current URL
            current_url = tab.url
            print(f"Current URL: {current_url}")
            
            try:
                print("Sending captcha to 2captcha for solving...")
                result = self.solver.recaptcha(
                    sitekey=sitekey,
                    url=current_url,
                    invisible=False,
                    enterprise=False
                )
                
                print(f"2captcha raw response: {result}")
                
                if result and 'code' in result:
                    token = result['code']
                    print("Successfully received token from 2captcha!")
                    print(f"Token (first 50 chars): {token[:50]}...")
                    
                    # Set the token using JavaScript
                    js_set_token = f"""
                        const elements = document.getElementsByName('g-recaptcha-response');
                        console.log('Found g-recaptcha-response elements:', elements);
                        if (elements.length > 0) {{
                            elements[0].value = '{token}';
                            return true;
                        }}
                        return false;
                    """
                    
                    if tab.run_js(js_set_token):
                        print("Successfully set token in page")
                        return token
                    else:
                        print("Failed to set token in page")
                        # Debug: Try to find the textarea
                        js_debug_textarea = """
                            const elements = document.getElementsByName('g-recaptcha-response');
                            return {
                                count: elements.length,
                                visible: elements.length > 0 ? !elements[0].hidden : false,
                                value: elements.length > 0 ? elements[0].value : null
                            };
                        """
                        textarea_info = tab.run_js(js_debug_textarea)
                        print(f"Textarea debug info: {textarea_info}")
                        return None
                        
                else:
                    print("Failed to get token from 2captcha")
                    print(f"2captcha response: {result}")
                    return None
                    
            except Exception as e:
                print(f"Error solving captcha with 2captcha: {str(e)}")
                import traceback
                print("Full traceback:")
                print(traceback.format_exc())
                return None
                
        except Exception as e:
            print(f"Error in solve_captcha_with_2captcha: {str(e)}")
            import traceback
            print("Full traceback:")
            print(traceback.format_exc())
            return None

    def process_single_tab(self, browser, results_queue):
        try:
            # Get new tab
            tab = browser.new_tab()
            
            # Visit webpage
            print("Loading webpage...")
            tab.get('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/')
            
            # Wait for Angular to load
            time.sleep(1)
            
            # Execute JavaScript to manipulate Angular state
            print("Setting up phone number...")
            js_code = """
                const element = document.querySelector('[ng-show="state==\\'number\\'"]');
                if (!element) {
                    throw new Error('Could not find the Angular element');
                }
                const scope = angular.element(element).scope();
                if (!scope) {
                    throw new Error('Could not get Angular scope');
                }
                scope.model = scope.model || {};
                scope.model.phone = '514-519-5990';
                scope.state = 'confirm';
                scope.$apply();
            """
            
            # Run the JavaScript and wait for page to load
            tab.run_js_loaded(js_code)
            
            # Wait for state change and reCAPTCHA frame to load
            print("Waiting for reCAPTCHA frame to load...")
            frame_info = self.wait_for_recaptcha_frame(tab)
            if not frame_info:
                print("Timed out waiting for reCAPTCHA frame to load")
                results_queue.put((False, None))
                return
            
            print("ReCAPTCHA iframe info:", frame_info)
            
            iframe = tab.get_frame(frame_info['name'])
            if not iframe:
                print("Could not get reCAPTCHA iframe")
                results_queue.put((False, None))
                return
            
            # Wait for reCAPTCHA iframe to be present and loaded
            js_wait_for_recaptcha = """
                const frames = document.getElementsByTagName('iframe');
                const frame = Array.from(frames).find(frame => 
                    frame.src && frame.src.includes('recaptcha') && 
                    frame.getBoundingClientRect().height > 0
                );
                if (frame) {
                    return {
                        found: true,
                        name: frame.name,
                        src: frame.src,
                        height: frame.getBoundingClientRect().height
                    };
                }
                return { found: false };
            """
            
            start_time = time.time()
            recaptcha_frame = None
            while time.time() - start_time < 25:
                frame_info = tab.run_js(js_wait_for_recaptcha)
                if frame_info.get('found'):
                    print(f"Found loaded reCAPTCHA frame with height: {frame_info['height']}")
                    print(f"ReCAPTCHA iframe info: {frame_info}")
                    recaptcha_frame = tab.get_frame(frame_info['name'])
                    if recaptcha_frame:
                        break
                time.sleep(0.1)
            
            if not recaptcha_frame:
                print("Failed to find reCAPTCHA frame")
                results_queue.put((False, None))
                return

            try:
                js_wait_for_checkbox = """
                    const checkbox = document.querySelector('#recaptcha-anchor');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    }
                    return false;
                """
                
                start_time = time.time()
                while time.time() - start_time < 10:
                    if recaptcha_frame.run_js(js_wait_for_checkbox):
                        break
                    time.sleep(0.1)

                time.sleep(0.5 + random.random())
                
                # Now that we've confirmed the captcha is fully loaded, solve it with 2captcha
                print("Captcha fully loaded, starting 2captcha solving process...")
                token = self.solve_captcha_with_2captcha(tab)
                
                if token:
                    print("Successfully got token from 2captcha")
                    if self.on_token_found:
                        asyncio.run(self._handle_token_found(token))
                    results_queue.put((True, token))
                else:
                    print("Failed to get token from 2captcha")
                    results_queue.put((False, None))
                    
            except Exception as e:
                print(f"An error occurred: {str(e)}")
                results_queue.put((False, None))
                return
                
        except Exception as e:
            print(f"Tab processing error: {str(e)}")
            results_queue.put((False, None))
        finally:
            try:
                tab.close()
            except:
                pass

    def extract_tokens(self):
        """
        Main method to extract captcha tokens using parallel browser tabs.
        Each tab will attempt to solve one captcha.
        """
        print(f"\nStarting execution with {self.tabs_per_browser} parallel tabs")
        print("=" * 50)

        try:
            options = self.get_chrome_options()
            browser = Chromium(options)
            
            results_queue = Queue()
            threads = []
            
            for _ in range(self.tabs_per_browser):
                thread = threading.Thread(target=self.process_single_tab, args=(browser, results_queue))
                thread.start()
                threads.append(thread)
                time.sleep(1)  # Small delay between starting threads
            
            # Wait for all threads to complete
            for thread in threads:
                thread.join()
            
            # Process results
            for _ in range(self.tabs_per_browser):
                success, token = results_queue.get()
                if success:
                    self.results.successful.append(token)
                else:
                    self.results.failed.append(datetime.now())
                self.results.total_attempts += 1
                
                # Print progress after each tab completion
                self.results.print_progress()
            
        except Exception as e:
            print(f"Browser error: {str(e)}")
        finally:
            browser.quit()
            time.sleep(1)

        # Print final results
        print("\nFinal Results:")
        print("=" * 50)
        print(f"Total attempts completed: {self.results.total_attempts}")
        print(f"Success rate: {self.results.success_rate:.1f}%")
        print(f"Total successful tokens: {len(self.results.successful)}")
        print(f"Failed attempts: {len(self.results.failed)}")
        print("=" * 50)
        
        return self.results.successful