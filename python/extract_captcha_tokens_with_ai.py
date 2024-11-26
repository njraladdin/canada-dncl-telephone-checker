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
import google.generativeai as genai

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
        profile_num = random.randint(1, 20)
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

    def analyze_with_gemini(self, screenshot_path, prompt, grid_type):
        """Analyze screenshot with Gemini AI"""
        try:
            print(f"Original prompt: {prompt}")
            
            # Extract just the main challenge text, ignoring dynamic instruction
            main_prompt = prompt.split('Click verify once there are none left')[0].strip()
            if main_prompt.endswith('.'):
                main_prompt = main_prompt[:-1]  # Remove trailing period if present
            
            print(f"Processed prompt: {main_prompt}")
            
            genai.configure(api_key=os.getenv("GEMINI_API_KEY"))
            
            generation_config = {
                "temperature": 1,
                "top_p": 0.95,
                "top_k": 40,
                "max_output_tokens": 8192,
                "response_mime_type": "application/json",
            }
            
            model = genai.GenerativeModel(
                model_name="gemini-1.5-flash",
                generation_config=generation_config,
            )
            
            # Upload image
            file = genai.upload_file(screenshot_path, mime_type="image/png")
            print(f"Uploaded file to Gemini: {screenshot_path}")
            
            # Construct prompt based on grid type
            grid_size = "16" if grid_type == "4x4" else "9"
            grid_desc = """Row 4: [1,1] - [1,2] - [1,3] - [1,4]
Row 3: [2,1] - [2,2] - [2,3] - [2,4]
Row 2: [3,1] - [3,2] - [3,3] - [3,4]
Row 1: [4,1] - [4,2] - [4,3] - [4,4]""" if grid_type == "4x4" else """Row 3: [1,1] - [1,2] - [1,3]
Row 2: [2,1] - [2,2] - [2,3]
Row 1: [3,1] - [3,2] - [3,3]"""

            final_prompt = f"""For each tile in the grid, check if it contains a VISIBLE -- {main_prompt} -- .
If the object is not present in ANY of the tiles, mark ALL tiles as "has_match": false.
Only mark a tile as "has_match": true if you are CERTAIN the object appears in that specific tile.

Respond with a JSON object where each key is the tile coordinate in [row,col] format and the value has a 'has_match' boolean.
Example response format:
{{
    "[1,1]": {{"has_match": false}},
    "[1,2]": {{"has_match": true}},
    ...
}}

Grid layout (row,column coordinates):
{grid_desc}

Important: If {main_prompt} does not appear in ANY tile, ALL tiles should have "has_match": false.
Respond ONLY with the JSON object."""

         
            
            # Create chat session with history
            chat = model.start_chat(history=[
                {
                    "role": "user",
                    "parts": [
                        file,
                        final_prompt
                    ]
                }
            ])
            
            # Get response
            response = chat.send_message("analyze the image")
            print("\n=== Gemini Response ===")
            print(response.text)
            print("=" * 30)
            
            # Extract JSON from response
            import json
            json_str = response.text.strip('`json\n').strip('`')
            result = json.loads(json_str)
            
            # Determine which tiles to click
            tiles_to_click = []
            for coord, data in result.items():
                if data.get('has_match', False):
                    tiles_to_click.append(coord)
            
            print("\n=== Tiles to Click ===")
            print(f"Found {len(tiles_to_click)} tiles to click: {tiles_to_click}")
            print("=" * 30)
            
            return tiles_to_click
            
        except Exception as e:
            print(f"\n=== Gemini Analysis Error ===")
            print(f"Error: {str(e)}")
            print(f"Type: {type(e)}")
            import traceback
            print(f"Traceback: {traceback.format_exc()}")
            print("=" * 30)
            return None

    def refresh_challenge(self, challenge_frame):
        """Click the reload button to get a new challenge"""
        js_refresh = """
            const reloadButton = document.querySelector('#recaptcha-reload-button');
            if (reloadButton) {
                reloadButton.click();
                return true;
            }
            return false;
        """
        return challenge_frame.run_js(js_refresh)

    def is_dynamic_challenge(self, challenge_frame):
        """Check if this is a dynamic challenge by looking for the text indicator"""
        js_check = """
            const desc = document.querySelector('.rc-imageselect-desc-no-canonical');
            if (desc) {
                // Get the strong element (contains the main object)
                const strongElement = desc.querySelector('strong');
                const dynamicSpan = desc.querySelector('span');
                
                return {
                    isDynamic: dynamicSpan && dynamicSpan.textContent.includes('Click verify once there are none left'),
                    mainText: strongElement ? strongElement.textContent.trim() : '',
                    fullText: desc.textContent.trim()
                };
            }
            return { isDynamic: false, mainText: '', fullText: '' };
        """
        result = challenge_frame.run_js(js_check)
        print("\n=== Dynamic Challenge Check ===")
        print(f"Full Text: {result.get('fullText', '')}")
        print(f"Main Text: {result.get('mainText', '')}")
        print(f"Is Dynamic: {result.get('isDynamic', False)}")
        print("=" * 30)
        return result

    def is_desired_challenge_format(self, challenge_frame):
        """Check if the challenge text matches our requirements:
        1. Must contain 'Select all images with'
        2. For dynamic challenges ('Click verify once there are none left'), accept them
        """
        js_check = """
            const desc = document.querySelector('.rc-imageselect-desc-no-canonical');
            if (desc) {
                const text = desc.textContent.trim();
                const hasCorrectFormat = text.includes('Select all images with');
                const hasDynamicText = text.includes('Click verify once there are none left');
                
                return {
                    matches: hasCorrectFormat,  // Accept all challenges with 'Select all images with'
                    mainText: text,
                    hasCorrectFormat: hasCorrectFormat,
                    hasDynamicText: hasDynamicText
                };
            }
            return { matches: false, mainText: '', hasCorrectFormat: false, hasDynamicText: false };
        """
        result = challenge_frame.run_js(js_check)
        print("\n=== Challenge Format Check ===")
        print(f"Full Text: {result.get('mainText', '')}")
        print(f"Has 'Select all images with': {result.get('hasCorrectFormat', False)}")
        print(f"Has dynamic text: {result.get('hasDynamicText', False)}")
        print(f"Matches Requirements: {result.get('matches', False)}")
        print("=" * 30)
        
        if not result.get('matches', False):
            print("Challenge rejected because:")
            if not result.get('hasCorrectFormat', False):
                print("- Does NOT contain 'Select all images with'")
            print("=" * 30)
        
        return result.get('matches', False)

    def solve_image_challenge(self, challenge_frame, max_attempts=3, current_attempt=0):
        """Solve the image challenge with a simplified flow"""
        try:
            print(f"\n=== Starting Challenge Attempt {current_attempt + 1}/{max_attempts} ===")
            
            # Step 1: Wait for challenge to fully load
            time.sleep(2)
            
            # Check if the challenge format matches what we want
            format_check = self.is_desired_challenge_format(challenge_frame)
            if not format_check:
                print("Challenge does not meet requirements - refreshing...")
                max_refresh_attempts = 12
                for i in range(max_refresh_attempts):
                    if self.refresh_challenge(challenge_frame):
                        print(f"Refreshing challenge (attempt {i + 1}/{max_refresh_attempts})")
                        time.sleep(2)  # Wait for new challenge to load
                        if self.is_desired_challenge_format(challenge_frame):
                            print("Got valid challenge - proceeding...")
                            break
                    if i == max_refresh_attempts - 1:
                        print("Could not get valid challenge after max refresh attempts")
                        return None
            
            # Step 2: Get challenge info and check if it's dynamic
            js_get_info = """
                const desc = document.querySelector('.rc-imageselect-desc-no-canonical');
                const strongElement = desc.querySelector('strong');
                const images = document.querySelectorAll('.rc-image-tile-wrapper img');
                const isDynamic = desc.textContent.includes('Click verify once there are none left');
                
                return {
                    promptText: strongElement ? strongElement.textContent.trim() : '',
                    gridType: images[0].className.includes('33') ? '3x3' : '4x4',
                    isDynamic: isDynamic,
                    imageSrcs: Array.from(images).map(img => ({
                        src: img.src,
                        className: img.className
                    }))
                };
            """
            challenge_info = challenge_frame.run_js(js_get_info)
            print("\n=== Challenge Info ===")
            print(f"Prompt Text: {challenge_info.get('promptText', '')}")
            print(f"Grid Type: {challenge_info.get('gridType', '')}")
            print(f"Is Dynamic: {challenge_info.get('isDynamic', False)}")
            print("=" * 30)
            
            # For dynamic challenges, we need to keep solving until no matches are found
            max_dynamic_iterations = 4  # Changed from 5 to 4 to limit screenshots
            dynamic_iteration = 0
            
            while True:
                # Step 3: Take screenshot
                target_element = challenge_frame('#rc-imageselect-target')
                if not target_element:
                    print("Could not find target element")
                    return None
                    
                # Save screenshot
                timestamp = int(time.time())
                screenshot_path = f"captcha_screenshots/challenge_{timestamp}.png"
                os.makedirs("captcha_screenshots", exist_ok=True)
                
                time.sleep(4)
                target_element.get_screenshot(path=screenshot_path)
                
                print(f"\n=== Processing Screenshot {dynamic_iteration + 1}/{max_dynamic_iterations} ===")
                
                # Step 4: Analyze with Gemini and click tiles
                tiles_to_click = self.analyze_with_gemini(screenshot_path, challenge_info['promptText'], challenge_info['gridType'])
                if tiles_to_click is None:  # Only None is an error, empty list is valid
                    print("Failed to get Gemini analysis")
                    return None

                # If no tiles to click, we can proceed to verify
                if not tiles_to_click:
                    print("No matching tiles found - proceeding to verify")
                    break

                # Click each tile
                for coord in tiles_to_click:
                    js_click = f"""
                        const tiles = document.querySelectorAll('.rc-imageselect-tile');
                        const gridSize = {3 if challenge_info['gridType'] == '3x3' else 4};
                        // Parse the [row,col] format string into actual numbers
                        const coordStr = '{coord}';
                        const [row, col] = coordStr.substring(1, coordStr.length - 1).split(',').map(Number);
                        // Calculate index: (row-1) * gridSize + (col-1)
                        // For example, [2,2] in 3x3 grid:
                        // (2-1) * 3 + (2-1) = 1 * 3 + 1 = 4 (middle tile)
                        const index = (row - 1) * gridSize + (col - 1);
                        console.log('Clicking tile at [' + row + ',' + col + '] -> index ' + index);
                        if (tiles[index]) {{
                            tiles[index].click();
                            return true;
                        }}
                        return false;
                    """
                    if not challenge_frame.run_js(js_click):
                        continue
                    time.sleep(0.05)  # Small delay between clicks

                # For non-dynamic challenges, break after one iteration
                if not challenge_info.get('isDynamic'):
                    break
                    
                # For dynamic challenges, wait for new images to load
                time.sleep(1)
                
                # Increment dynamic iteration counter and check limit
                dynamic_iteration += 1
                if dynamic_iteration >= max_dynamic_iterations:
                    print(f"Reached maximum dynamic iterations ({max_dynamic_iterations})")
                    break

            # Step 5: Click verify and check result
            print("Clicking verify button...")
            challenge_frame.run_js('document.querySelector("#recaptcha-verify-button").click()')
            time.sleep(2)
            
            # Comprehensive success check
            js_check_status = """
                // Check multiple success indicators
                const successElement = document.querySelector('.rc-imageselect-success');
                const incorrectElement = document.querySelector('.rc-imageselect-incorrect');
                const newChallengeElement = document.querySelector('.rc-imageselect-challenge');
                const checkboxFrame = window.parent.document.querySelector('iframe[src*="anchor"]');
                const verifyButton = document.querySelector('#recaptcha-verify-button');
                
                // Check if checkbox is checked (indicates success)
                const isCheckboxChecked = () => {
                    try {
                        const checkbox = checkboxFrame.contentDocument.querySelector('.recaptcha-checkbox-checked');
                        return !!checkbox;
                    } catch {
                        return false;
                    }
                };
                
                // Success cases:
                // 1. Success message is shown
                // 2. Checkbox is checked
                // 3. Challenge iframe is closed/hidden
                // 4. Verify button is gone (challenge completed)
                if (successElement || isCheckboxChecked() || !verifyButton) {
                    return 'success';
                }
                // Error cases
                else if (incorrectElement) {
                    return 'incorrect';
                }
                // New challenge case
                else if (newChallengeElement) {
                    return 'new_challenge';
                }
                
                return 'unknown';
            """
            status = challenge_frame.run_js(js_check_status)
            
            if status == 'success':
                print("Challenge solved successfully!")
                return True
            elif status == 'new_challenge' and current_attempt < max_attempts:
                print("New challenge appeared - attempting to solve...")
                time.sleep(1)
                return self.solve_image_challenge(challenge_frame, max_attempts, current_attempt + 1)
            else:
                print(f"Challenge failed with status: {status}")
                return None
                
        except Exception as e:
            print(f"Error solving challenge: {str(e)}")
            return None

    def process_single_tab(self, browser, results_queue):
        tab = None
        start_time = time.time()
        TAB_TIMEOUT = 90  # 1.5 minutes in seconds
        
        try:
            # Get new tab
            tab = browser.new_tab()
            
            # Visit webpage
            tab.get('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/')
            
            # Wait for Angular to load - reduced from 1s to 0.5s
            time.sleep(0.5)
            
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
            
            try:
                js_wait_for_checkbox = """
                    const checkbox = document.querySelector('#recaptcha-anchor');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        return rect.width > 0 && rect.height > 0;
                    }
                    return false;
                """
                
                start_wait_time = time.time()
                while time.time() - start_wait_time < 10:
                    if time.time() - start_time >= TAB_TIMEOUT:
                        print("Tab timeout reached (1.5 minutes) - closing tab")
                        results_queue.put((False, None))
                        return
                        
                    if iframe.run_js(js_wait_for_checkbox):
                        break
                    time.sleep(0.05)  # Reduced from 0.1 to 0.05

                # Reduced from 0.5 + random to 0.2 + random/2
                time.sleep(0.2 + random.random()/2)
                
                js_click_checkbox = """
                    const checkbox = document.querySelector('#recaptcha-anchor');
                    if (checkbox) {
                        checkbox.click();
                        return true;
                    }
                    return false;
                """
                if not iframe.run_js(js_click_checkbox):
                    print("Failed to click reCAPTCHA checkbox")
                    results_queue.put((False, None))
                    return
                
                # Reduced from 1s to 0.5s
                time.sleep(0.5)

                start_check_time = time.time()
                while time.time() - start_check_time < 7:
                    if time.time() - start_time >= TAB_TIMEOUT:
                        print("Tab timeout reached (1.5 minutes) - closing tab")
                        results_queue.put((False, None))
                        return
                        
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
                        print("Challenge detected! Attempting image challenge...")
                        # Reduced from 1s to 0.5s
                        time.sleep(0.5)
                        challenge_frame = tab.get_frame(challenge_info['name'])
                        if challenge_frame:
                            if self.solve_image_challenge(challenge_frame):
                                solve_start_time = time.time()
                                while time.time() - solve_start_time < 10:
                                    if time.time() - start_time >= TAB_TIMEOUT:
                                        print("Tab timeout reached (1.5 minutes) - closing tab")
                                        results_queue.put((False, None))
                                        return
                                        
                                    token = tab.run_js(js_check_token)
                                    if token:
                                        print(f"Token received after image challenge: {token[:50]}..." if len(token) > 50 else token)
                                        if self.on_token_found:
                                            asyncio.run(self._handle_token_found(token))
                                        results_queue.put((True, token))
                                        return
                                    time.sleep(0.05)  # Reduced from 0.5 to 0.05
                            print("Failed to solve image challenge")
                            results_queue.put((False, None))
                            return
                    
                    time.sleep(0.05)  # Reduced from 0.1 to 0.05
                    
                    # Check timeout after each iteration
                    if time.time() - start_time >= TAB_TIMEOUT:
                        print("Tab timeout reached (1.5 minutes) - closing tab")
                        results_queue.put((False, None))
                        return
                
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
                if tab:
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
                time.sleep(0.5)  # Small delay between starting threads
            
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