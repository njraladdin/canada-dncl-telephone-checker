from camoufox.sync_api import Camoufox
import os
import time
import random
from dotenv import load_dotenv
from browserforge.fingerprints import Screen

load_dotenv()

TEST_PHONE_NUMBER = '418-313-3337'

def attempt_captcha(page):
    try:
        # Add initial random delay before navigation (1-3 seconds)
        time.sleep(random.uniform(1, 3))
        
        print('Loading registration check page...')
        page.goto('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/')
        
        # Random delay before typing (1-2 seconds)
        time.sleep(random.uniform(1, 2))
        
        print('Waiting for phone input...')
        phone_input = page.locator('#phone')
        
        # Type number with random delays between characters
        for digit in TEST_PHONE_NUMBER:
            phone_input.type(digit, delay=random.uniform(50, 150))
            time.sleep(random.uniform(0.1, 0.3))
            
        print('Entered phone number')

        # Random delay before clicking next (1-3 seconds)
        time.sleep(random.uniform(1, 3))
        
        print('Clicking next button...')
        next_button = page.locator('#wb-auto-1 > form > div.submit-container > button')
        next_button.click()
        print('Clicked next button')

        print('Waiting for reCAPTCHA iframe...')
        
        iframe = page.frame_locator('iframe[src*="recaptcha"]').first
        if not iframe:
            iframe = page.frame_locator('iframe[src*="google.com"]').first
            
        if not iframe:
            raise Exception("Could not find reCAPTCHA iframe")
                
        print('Found reCAPTCHA iframe')
        
        checkbox = iframe.locator('.recaptcha-checkbox-border')
        
        # Increased delay range before clicking checkbox (3-6 seconds)
        delay = random.uniform(3, 6)
        print(f'Waiting {delay:.2f}s before clicking...')
        time.sleep(delay)
        
        checkbox.click()
        print('Clicked recaptcha checkbox')
        
        return wait_for_token(page)

    except Exception as e:
        print(f'An error occurred: {e}')
        return None

def wait_for_token(page):
    print('Waiting for token...')
    token = None
    timeout = time.time() + 7  # 7 second timeout
    
    # Try every 100ms instead of waiting longer periods
    while time.time() < timeout:
        # Fix the JavaScript evaluation by wrapping in a function
        token = page.evaluate('''() => {
            const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
            return textarea ? textarea.value : null;
        }''')
        if token:
            print('reCAPTCHA token received')
            return token
        time.sleep(0.1)  # Check every 100ms
        
        # Add progress indicator every second
        if int(time.time()) % 1 == 0:
            print('.', end='', flush=True)
    
    print('\nToken not received within 7 seconds')
    return None

def main():
    try:
        # Initialize Camoufox with enhanced anti-detection settings
        with Camoufox(
            geoip=True,         # Enable geolocation spoofing
            humanize=True,      # Enable human-like cursor movement
            screen=Screen(      # Constrain screen size to common dimensions
                min_width=1024,
                max_width=1920,
                min_height=768,
                max_height=1080
            ),
            os="windows",       # Use Windows fingerprint for better blend-in
        ) as browser:
            page = browser.new_page()
            
            # Attempt captcha
            token = attempt_captcha(page)
            print(f'Captcha token: {token}')
        
    except Exception as e:
        print(f'An error occurred: {e}')

if __name__ == "__main__":
    main() 