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
from datetime import datetime, timedelta
import asyncio
from twocaptcha import TwoCaptcha
from colorama import Fore, Style

# Configuration Constants
CHROME_PATHS = {
    'win32': "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    'linux': "/usr/bin/google-chrome"
}

@dataclass
class ResultState:
    successful: List[dict] = field(default_factory=list)  # Store successful DNCL checks
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
        print(f"Total successful checks: {len(self.successful)}")
        print(f"Failed attempts: {len(self.failed)}")
        print("=" * 50)

class CaptchaTokenExtractor:
    def __init__(self, tabs_per_browser=6, headless=False, on_token_found=None):
        self.tabs_per_browser = tabs_per_browser
        self.headless = headless
        self.results = ResultState()
        self.on_token_found = on_token_found
        self.solver = TwoCaptcha(os.getenv('2CAPTCHA_API_KEY'))
        self.used_tokens = set()
        self.current_phone = None
        
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
                
                # Get the user agent from the browser
                user_agent = tab.run_js("return navigator.userAgent")
                
                # Get any cookies that might be relevant
                cookies = tab.run_js("""
                    return document.cookie.split('; ')
                        .map(c => c.split('='))
                        .reduce((acc, [key, value]) => {
                            acc[key] = value;
                            return acc;
                        }, {});
                """)
                
                cookie_string = '; '.join([f"{k}={v}" for k, v in cookies.items()])
                
                result = self.solver.recaptcha(
                    sitekey=sitekey,
                    url=current_url,
                    invisible=False,
                    enterprise=False,
                    # Add additional parameters
                    user_agent=user_agent,    # Pass browser's user agent
                    cookies=cookie_string   # Pass relevant cookies
                 
                )
                
                print(f"2captcha raw response: {result}")
                
                if result and 'code' in result:
                    token = result['code']
                    
                    # Check if token was already used
                    if token in self.used_tokens:
                        print("Warning: Token was already used! Requesting new token...")
                        return None
                        
                    # Add token to used set
                    self.used_tokens.add(token)
                    
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
                        self.used_tokens.remove(token)  # Remove from used set if failed to set
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

    def process_single_tab(self, browser, results_queue, phone_number):
        try:
            # Store the phone number
            self.current_phone = phone_number
            
            # Get new tab
            tab = browser.new_tab()
            
            # Visit webpage
            print(f"\n{Fore.CYAN}Processing phone number: {Fore.YELLOW}{phone_number}{Style.RESET_ALL}")
            tab.get('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/')
            
            # Wait for Angular to load and be ready
            print("Waiting for Angular to initialize...")
            js_wait_angular = """
                return new Promise((resolve, reject) => {
                    const maxWaitTime = 10000; // 10 seconds timeout
                    const startTime = Date.now();
                    
                    const checkAngular = () => {
                        if (window.angular && document.querySelector('[ng-show]')) {
                            resolve(true);
                            return;
                        }
                        
                        if (Date.now() - startTime > maxWaitTime) {
                            reject(new Error('Timeout waiting for Angular'));
                            return;
                        }
                        
                        setTimeout(checkAngular, 100);
                    };
                    checkAngular();
                });
            """
            try:
                tab.run_js_loaded(js_wait_angular, timeout=12)  # 12 seconds total timeout (including network delays)
                print("Angular initialized successfully")
            except Exception as e:
                print(f"Failed to initialize Angular: {str(e)}")
                raise
            
            # Execute JavaScript to set the phone number
            js_code = f"""
                const element = document.querySelector('[ng-show="state==\\'number\\'"]');
                if (!element) {{
                    throw new Error('Could not find the Angular element');
                }}
                const scope = angular.element(element).scope();
                if (!scope) {{
                    throw new Error('Could not get Angular scope');
                }}
                scope.model = scope.model || {{}};
                scope.model.phone = '{phone_number}';
                scope.state = 'confirm';
                scope.$apply();
            """
            
            # Run the JavaScript and wait for page to load
            tab.run_js(js_code)
            
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
                    
                    # More comprehensive JavaScript to handle the reCAPTCHA
                    js_solve_captcha = f"""
                        // First set the response in textarea
                        const textarea = document.querySelector('[name="g-recaptcha-response"]');
                        if (textarea) {{
                            textarea.style.display = 'block'; // Make it visible for debugging
                            textarea.value = '{token}';
                        }}

                        // Set response in iframe textarea if it exists
                        const iframes = document.getElementsByTagName('iframe');
                        for (const iframe of iframes) {{
                            try {{
                                const iframeDocument = iframe.contentWindow.document;
                                const iframeTextarea = iframeDocument.querySelector('[name="g-recaptcha-response"]');
                                if (iframeTextarea) {{
                                    iframeTextarea.value = '{token}';
                                }}
                            }} catch (e) {{
                                // Cross-origin access might fail
                                console.log('Could not access iframe:', e);
                            }}
                        }}

                        // Trigger the grecaptcha callback
                        try {{
                            if (window.___grecaptcha_cfg) {{
                                const clientIds = Object.keys(window.___grecaptcha_cfg.clients);
                                
                                for (const clientId of clientIds) {{
                                    const client = window.___grecaptcha_cfg.clients[clientId];
                                    
                                    // Find callback in client object
                                    for (const key in client) {{
                                        if (client[key] && typeof client[key] === 'object') {{
                                            const tokens = Object.keys(client[key]);
                                            for (const token of tokens) {{
                                                const obj = client[key][token];
                                                if (obj && obj.callback) {{
                                                    console.log('Found callback, executing...');
                                                    obj.callback('{token}');
                                                }}
                                            }}
                                        }}
                                    }}
                                }}
                            }}
                        }} catch (e) {{
                            console.error('Error triggering callback:', e);
                        }}

                        // Alternative method to trigger verification
                        try {{
                            window.grecaptcha.enterprise.getResponse = function() {{ return '{token}'; }};
                            window.grecaptcha.getResponse = function() {{ return '{token}'; }};
                        }} catch (e) {{
                            console.log('Could not override getResponse:', e);
                        }}

                        return document.querySelector('[name="g-recaptcha-response"]').value === '{token}';
                    """
                    
                    print("Injecting and triggering reCAPTCHA solution...")
                    success = tab.run_js(js_solve_captcha)
                    print(f"Token injection result: {success}")
                    
                    # Wait for the reCAPTCHA to be processed
                    time.sleep(3)
                    
                    # Verify the token was properly set
                    js_verify = """
                        const result = {
                            'textarea_found': false,
                            'textarea_value': null,
                            'checkbox_found': false,
                            'checkbox_checked': false,
                            'debug': {
                                'iframes_count': 0,
                                'recaptcha_elements': []
                            }
                        };
                        
                        // Check main textarea
                        const textarea = document.querySelector('[name="g-recaptcha-response"]');
                        if (textarea) {
                            result.textarea_found = true;
                            result.textarea_value = textarea.value;
                        }
                        
                        // Check all iframes for recaptcha elements
                        const iframes = document.getElementsByTagName('iframe');
                        result.debug.iframes_count = iframes.length;
                        
                        for (const iframe of iframes) {
                            try {
                                result.debug.recaptcha_elements.push({
                                    'src': iframe.src,
                                    'id': iframe.id,
                                    'name': iframe.name,
                                    'class': iframe.className
                                });
                                
                                if (iframe.src && iframe.src.includes('recaptcha')) {
                                    const checkbox = iframe.contentDocument.querySelector('.recaptcha-checkbox');
                                    if (checkbox) {
                                        result.checkbox_found = true;
                                        result.checkbox_checked = checkbox.classList.contains('recaptcha-checkbox-checked');
                                    }
                                }
                            } catch (e) {
                                console.log('Could not access iframe:', e);
                            }
                        }
                        
                        return result;
                    """

                    verify_result = tab.run_js(js_verify)
                    print("Verification details:")
                    print(f"- Textarea found: {verify_result.get('textarea_found')}")
                    print(f"- Textarea value set: {'Yes' if verify_result.get('textarea_value') else 'No'}")
                    print(f"- Checkbox found: {verify_result.get('checkbox_found')}")
                    print(f"- Checkbox checked: {verify_result.get('checkbox_checked')}")
                    print("\nDebug information:")
                    print(f"- Number of iframes: {verify_result.get('debug', {}).get('iframes_count')}")
                    print("- ReCAPTCHA elements found:")
                    for elem in verify_result.get('debug', {}).get('recaptcha_elements', []):
                        print(f"  * {elem}")

                    # If the verification shows the token wasn't properly set, try an alternative method
                    if not verify_result.get('checkbox_checked'):
                        print("\nTrying alternative method to trigger reCAPTCHA...")
                        js_alternative = f"""
                            try {{
                                // Try to find the reCAPTCHA iframe
                                const recaptchaFrame = Array.from(document.getElementsByTagName('iframe'))
                                    .find(iframe => iframe.src && iframe.src.includes('recaptcha'));
                                    
                                if (recaptchaFrame) {{
                                    // Force the checkbox to be checked
                                    const frameDoc = recaptchaFrame.contentDocument;
                                    const checkbox = frameDoc.querySelector('.recaptcha-checkbox');
                                    if (checkbox) {{
                                        checkbox.classList.add('recaptcha-checkbox-checked');
                                    }}
                                    
                                    // Attempt to trigger verification
                                    window.___grecaptcha_cfg.clients[0].aa.callback('{token}');
                                    return true;
                                }}
                                return false;
                            }} catch (e) {{
                                console.error('Alternative method failed:', e);
                                return false;
                            }}
                        """
                        alternative_result = tab.run_js(js_alternative)
                        print(f"Alternative method result: {alternative_result}")

                    # Click the submit button
                    print("Attempting to click the submit button...")
                    js_click_button = """
                        const button = document.querySelector('#wb-auto-2 > form > div > div.submit-container > button:nth-child(2)');
                        if (button) {
                            // Force enable the button if it's disabled
                            button.disabled = false;
                            button.click();
                            return true;
                        }
                        return false;
                    """
                    
                    if tab.run_js(js_click_button):
                        print("Successfully clicked the submit button!")
                        
                        # Wait for Angular to process and update the view
                        print("Waiting for results page to load...")
                        js_wait_for_results = """
                            return new Promise((resolve) => {
                                const maxAttempts = 20;  // 20 * 500ms = 10 seconds max
                                let attempts = 0;
                                
                                function checkResults() {
                                    // Check if we're on results page using Angular state
                                    const element = document.querySelector('[ng-if="state==\\'results\\'"]');
                                    if (element && window.getComputedStyle(element).display !== 'none') {
                                        // Get all the relevant information
                                        const result = {
                                            status: 'UNKNOWN',
                                            phone: null,
                                            registration_date: null,
                                            raw_text: null,
                                            error: null
                                        };
                                        
                                        try {
                                            // Get the registration status text
                                            const statusDiv = document.querySelector('.rc-left');
                                            if (statusDiv) {
                                                result.raw_text = statusDiv.innerText.trim();
                                                result.status = statusDiv.innerText.includes('currently registered') ? 'ACTIVE' : 'INACTIVE';
                                            }
                                            
                                            // Get the phone number
                                            const phoneDiv = document.querySelector('div[ng-if="result.existed"]');
                                            if (phoneDiv) {
                                                result.phone = phoneDiv.innerText.trim();
                                            }
                                            
                                            // Get registration date if active
                                            const dateDiv = document.querySelector('div[ng-if="userLang===\\'en\\'"]');
                                            if (dateDiv) {
                                                result.registration_date = dateDiv.innerText.trim();
                                            }
                                            
                                            resolve({ loaded: true, data: result });
                                            return;
                                        } catch (e) {
                                            result.error = `Error parsing results: ${e.message}`;
                                            resolve({ loaded: true, data: result });
                                            return;
                                        }
                                    }
                                    
                                    // Check for error messages
                                    const errorMsg = document.body.innerText;
                                    if (errorMsg.includes('error') || errorMsg.includes('Error')) {
                                        resolve({ 
                                            loaded: true, 
                                            data: {
                                                status: 'ERROR',
                                                error: errorMsg.substring(0, 200)
                                            }
                                        });
                                        return;
                                    }
                                    
                                    // Continue checking if max attempts not reached
                                    if (attempts < maxAttempts) {
                                        attempts++;
                                        setTimeout(checkResults, 500);
                                    } else {
                                        resolve({ 
                                            loaded: false, 
                                            data: {
                                                status: 'ERROR',
                                                error: 'Timeout waiting for results page'
                                            }
                                        });
                                    }
                                }
                                
                                checkResults();
                            });
                        """
                        
                        result = tab.run_js(js_wait_for_results)
                        
                        if result.get('loaded'):
                            data = result.get('data', {})
                            status = data.get('status')
                            
                            # Print result in a clear, formatted way
                            print("\n" + "="*50)
                            print(f"{Fore.CYAN}Results for phone number: {Fore.YELLOW}{self.current_phone}{Style.RESET_ALL}")
                            print("-"*50)
                            
                            if status == 'ERROR':
                                print(f"{Fore.RED}Status: ERROR")
                                print(f"Error message: {data.get('error')}{Style.RESET_ALL}")
                                results_queue.put((False, {
                                    'status': 'ERROR',
                                    'error': data.get('error'),
                                    'phone': self.current_phone
                                }))
                            else:
                                status_color = Fore.GREEN if status == 'ACTIVE' else Fore.RED
                                print(f"{status_color}Status: {status}")
                                print(f"Phone: {data.get('phone')}")
                                if data.get('registration_date'):
                                    print(f"Registration Date: {data.get('registration_date')}")
                                print(f"Raw Text: {data.get('raw_text')}{Style.RESET_ALL}")
                                
                                # Create result dictionary
                                result_data = {
                                    'status': status,
                                    'phone': self.current_phone,
                                    'registration_date': data.get('registration_date'),
                                    'Active': status == 'ACTIVE'
                                }
                                
                                results_queue.put((True, result_data))
                            
                            print("="*50 + "\n")
                            
                        else:
                            print(f"{Fore.RED}Failed to load results page{Style.RESET_ALL}")
                            results_queue.put((False, {
                                'status': 'ERROR',
                                'error': 'Failed to load results page',
                                'phone': self.current_phone
                            }))
                            # Wait 60 seconds after submitting form
                            print(f"{Fore.CYAN}Waiting 60 seconds ...{Style.RESET_ALL}")
                            time.sleep(120)
                    else:
                        print("Failed to find or click the submit button")
                        results_queue.put((False, None))
                else:
                    print("Failed to get token from 2captcha")
                    results_queue.put((False, None))
                    
            except Exception as e:
                print(f"Tab processing error: {str(e)}")
                import traceback
                traceback.print_exc()
                results_queue.put((False, {
                    'status': 'ERROR',
                    'error': str(e),
                    'phone': self.current_phone
                }))
        finally:
            try:
                tab.close()
            except:
                pass

    def extract_tokens(self, phone_numbers):
        """
        Main method to check DNCL status for phone numbers using parallel browser tabs.
        Each tab will process one phone number and return its DNCL status.
        
        Args:
            phone_numbers (list): List of phone numbers to check
        
        Returns:
            list: List of dictionaries containing DNCL status results
        """
        print(f"\nStarting execution with {self.tabs_per_browser} parallel tabs")
        print("=" * 50)

        results = []
        try:
            options = self.get_chrome_options()
            browser = Chromium(options)
            
            results_queue = Queue()
            threads = []
            
            # Process phone numbers in batches of tabs_per_browser
            for i in range(0, len(phone_numbers), self.tabs_per_browser):
                batch = phone_numbers[i:i + self.tabs_per_browser]
                threads = []
                
                for phone in batch:
                    thread = threading.Thread(
                        target=self.process_single_tab, 
                        args=(browser, results_queue, phone)
                    )
                    thread.start()
                    threads.append(thread)
                    time.sleep(1)  # Small delay between starting threads
                
                # Wait for all threads in this batch to complete
                for thread in threads:
                    thread.join()
                
                # Process results for this batch
                for _ in range(len(batch)):
                    success, result = results_queue.get()
                    if success:
                        self.results.successful.append(result)
                        results.append(result)
                    else:
                        self.results.failed.append(datetime.now())
                        # Still append error results to return list
                        results.append(result)
                    self.results.total_attempts += 1
                    self.results.print_progress()
            
        except Exception as e:
            print(f"Browser error: {str(e)}")
        finally:
            browser.quit()
            time.sleep(1)

        return results