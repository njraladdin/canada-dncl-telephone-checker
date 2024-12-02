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
        self.total_attempts = tabs_per_browser
        self.results = ResultState()
        self.on_token_found = on_token_found
        
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

                # Add proxy extension
        proxy_extension_path = os.path.join(os.path.dirname(__file__), 'proxies_extension')
        if os.path.exists(proxy_extension_path):
            co.add_extension(proxy_extension_path)
            print(f"Added proxy extension from: {proxy_extension_path}")
        else:
            print(f"Warning: Proxy extension not found at {proxy_extension_path}")
        
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

    def download_audio(self, url, max_attempts=3):
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
        
        for attempt in range(max_attempts):
            try:
                print(f"Downloading audio attempt {attempt + 1}/{max_attempts}")
                response = requests.get(url, headers=headers, timeout=60)
                if response.status_code == 200:
                    return response.content
                print(f"Download failed with status code: {response.status_code}")
            except Exception as e:
                print(f"Download attempt {attempt + 1} failed: {str(e)}")
            if attempt < max_attempts - 1:
                time.sleep(1)
        return None

    def transcribe_audio(self, audio_data):
        # Get wit tokens from environment
        wit_tokens = [
            os.getenv('WIT_TOKEN'),
            os.getenv('WIT_TOKEN_1'),
            os.getenv('WIT_TOKEN_2')
        ]
        wit_tokens = [token for token in wit_tokens if token]  # Remove None values
        
        if not wit_tokens:
            print("No wit.ai tokens found in environment")
            print("Available environment variables:", {k: v for k, v in os.environ.items() if 'WIT' in k})
            return None
        
        # Randomly choose a token
        wit_token = random.choice(wit_tokens)
        print(f"Using wit token: {wit_token[:8]}...")  # Print first 8 chars for debugging
        
        headers = {
            'Authorization': f'Bearer {wit_token}',
            'Content-Type': 'audio/mpeg3'
        }
        
        max_attempts = 3
        for attempt in range(max_attempts):
            try:
                print(f"Transcription attempt {attempt + 1}/{max_attempts}")
                response = requests.post(
                    'https://api.wit.ai/speech?v=20220622',
                    headers=headers,
                    data=audio_data,
                    timeout=120
                )
                
                if response.status_code == 200:
                    try:
                        # Parse response and extract text
                        response_text = response.text
                        print(f"Wit.ai response first 100 chars: {response_text[:100]}")
                        
                        # Find all text matches
                        import re
                        matches = re.findall(r'"text":\s*"([^"]+)"', response_text)
                        if matches:
                            transcription = matches[-1]  # Get the last match
                            print(f"Transcribed text: {transcription}")
                            return transcription
                        else:
                            print("No transcription found in response")
                    except Exception as e:
                        print(f"Error parsing transcription response: {str(e)}")
                else:
                    print(f"Transcription failed with status code: {response.status_code}")
                    print(f"Response: {response.text[:200]}")
            except Exception as e:
                print(f"Transcription attempt {attempt + 1} failed: {str(e)}")
            if attempt < max_attempts - 1:
                time.sleep(1)
        return None

    def solve_audio_challenge(self, challenge_frame):
        try:
            # Click audio button immediately
            audio_button = challenge_frame('#recaptcha-audio-button')
            if not audio_button:
                print("Audio button not found")
                return None
            
            print("Clicking audio button...")
            audio_button.click()
            time.sleep(1)
            
            # Check for blocking message
            blocking_text = challenge_frame('.rc-doscaptcha-header-text')
            if blocking_text and ('Try again later' in blocking_text.text or 'automated queries' in blocking_text.text):
                print(f"Blocking message detected: {blocking_text.text}")
                return None
            
            max_attempts = 3
            for attempt in range(max_attempts):
                try:
                    # Wait for audio download link
                    download_link = challenge_frame('.rc-audiochallenge-tdownload-link')
                    if not download_link:
                        print("Audio challenge link not found")
                        return None
                    
                    # Get audio source URL
                    audio_source = challenge_frame('#audio-source')
                    if not audio_source:
                        print("Audio source not found")
                        return None
                    
                    audio_url = audio_source.attr('src')
                    if not audio_url:
                        print("Audio URL not found")
                        return None
                    
                    print(f"Found audio URL: {audio_url}")
                    
                    # Download and transcribe audio
                    audio_data = self.download_audio(audio_url)
                    if not audio_data:
                        print("Failed to download audio")
                        return None
                    
                    transcription = self.transcribe_audio(audio_data)
                    if not transcription:
                        print("Failed to transcribe audio")
                        # Try reloading if transcription fails
                        reload_button = challenge_frame('#recaptcha-reload-button')
                        if reload_button and attempt < max_attempts - 1:
                            print("Clicking reload button...")
                            reload_button.click()
                            time.sleep(1)
                            continue
                        return None
                    
                    # Enter the transcription
                    print(f"Entering transcription: {transcription}")
                    response_input = challenge_frame('#audio-response')
                    if response_input:
                        self.random_delay()
                        response_input.click()
                        self.random_delay()
                        response_input.input(transcription)
                        
                        # Click verify
                        verify_button = challenge_frame('#recaptcha-verify-button')
                        if verify_button:
                            self.random_delay()
                            verify_button.click()
                            
                            # Wait for result
                            time.sleep(1)
                            return True
                        else:
                            print("Verify button not found")
                    else:
                        print("Response input not found")
                    
                except Exception as e:
                    print(f"Error in audio challenge attempt {attempt + 1}: {str(e)}")
                    if attempt < max_attempts - 1:
                        time.sleep(0.5)
                        continue
                
            return None
            
        except Exception as e:
            print(f"Error in solve_audio_challenge: {str(e)}")
            return None

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

    def wait_for_checkbox_clickable(self, iframe, timeout=10):
        """Wait for the checkbox to be visible and clickable"""
        start_time = time.time()
        while time.time() - start_time < timeout:
            try:
                # Try different selectors
                selectors = [
                    '.recaptcha-checkbox-border',
                    '#recaptcha-anchor',
                    'div[role="presentation"]'
                ]
                
                for selector in selectors:
                    checkbox = iframe(selector)
                    if checkbox:
                        # Verify the checkbox is visible using JavaScript
                        js_check = """
                            const element = document.querySelector('%s');
                            if (element) {
                                const rect = element.getBoundingClientRect();
                                const style = window.getComputedStyle(element);
                                return {
                                    width: rect.width,
                                    height: rect.height,
                                    visible: style.display !== 'none' && 
                                            style.visibility !== 'hidden' && 
                                            rect.width > 0 && 
                                            rect.height > 0
                                };
                            }
                            return null;
                        """ % selector
                        
                        result = iframe.run_js(js_check)
                        if result and result.get('visible'):
                            print(f"Found clickable checkbox with selector: {selector}")
                            print(f"Dimensions: {result}")
                            return checkbox
                
                time.sleep(0.2)
            except Exception as e:
                print(f"Error checking checkbox: {str(e)}")
                time.sleep(0.2)
        return None

    def process_single_tab(self, browser, results_queue):
        try:
            # Get new tab
            tab = browser.new_tab()
            
            # Visit webpage
            tab.get('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/')
            
            # Wait for Angular to load
            time.sleep(1)
            
            # Execute JavaScript to manipulate Angular state
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
                
                js_click_checkbox = """
                    const checkbox = document.querySelector('#recaptcha-anchor');
                    if (checkbox) {
                        checkbox.click();
                        return true;
                    }
                    return false;
                """
                if not recaptcha_frame.run_js(js_click_checkbox):
                    print("Failed to click reCAPTCHA checkbox")
                    results_queue.put((False, None))
                    return
                
                time.sleep(1)

                start_time = time.time()
                while time.time() - start_time < 7:
                    js_check_token = """
                        const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
                        return textarea ? textarea.value : null;
                    """
                    token = tab.run_js(js_check_token)
                    if token:
                        print(f"Token received: {token[:50]}..." if len(token) > 50 else token)
                        if self.on_token_found:
                            asyncio.run(self._handle_token_found(token))
                        results_queue.put((True, token))
                        return
                    
                    js_check_challenge = """
                        const frames = document.getElementsByTagName('iframe');
                        for (let frame of frames) {
                            if (frame.src && frame.src.includes('api2/bframe')) {
                                return {
                                    found: true,
                                    name: frame.name,
                                    src: frame.src
                                };
                            }
                        }
                        return { found: false };
                    """
                    
                    challenge_info = tab.run_js(js_check_challenge)
                    if challenge_info.get('found'):
                        print("Challenge detected! Attempting audio challenge...")
                        time.sleep(1)
                        challenge_frame = tab.get_frame(challenge_info['name'])
                        if challenge_frame:
                            if self.solve_audio_challenge(challenge_frame):
                                solve_start_time = time.time()
                                while time.time() - solve_start_time < 10:
                                    token = tab.run_js(js_check_token)
                                    if token:
                                        print(f"Token received after audio challenge: {token[:50]}..." if len(token) > 50 else token)
                                        if self.on_token_found:
                                            asyncio.run(self._handle_token_found(token))
                                        results_queue.put((True, token))
                                        return
                                    time.sleep(0.5)
                            print("Failed to solve audio challenge")
                            results_queue.put((False, None))
                            return
                    
                    time.sleep(0.1)
                
                print("No token or challenge detected after timeout")
                results_queue.put((False, None))
                return
                
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