from camoufox.async_api import AsyncCamoufox
from browserforge.fingerprints import Screen, FingerprintGenerator
import random
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Create a persistent user directory path
USER_DATA_DIR = os.path.join(os.path.dirname(__file__), "camoufox_data")

# Proxy configuration
PROXY_CONFIG = {
    'server': 'premium-residential.geonode.com:9009',
    'username': os.getenv('PROXY_USERNAME'),
    'password': os.getenv('PROXY_PASSWORD')
}
PHONE_NUMBER= '613-324-6266'
async def main():
    fg = FingerprintGenerator(browser='firefox')
    
    async with AsyncCamoufox(
        headless=False,
        humanize=True,
        screen=Screen(max_width=1920, max_height=1080),
        block_webrtc=True,
        geoip=True,
        os="windows",
        allow_webgl=True,
        i_know_what_im_doing=True,
        fingerprint=fg.generate(),
        persistent_context=True,
        user_data_dir=USER_DATA_DIR,
      #  proxy=PROXY_CONFIG
    ) as context:
        page = await context.new_page()
        
        await page.wait_for_timeout(1000 + (random.random() * 2000))
        
        await page.goto('https://lnnte-dncl.gc.ca/en/Consumer/Check-your-registration/#!/', timeout=6000000)
        
        # Wait for phone input field and handle input
        phone_input = await page.wait_for_selector('#phone')
        
        # Click to focus and clear any existing value
        await phone_input.click(click_count=3)  # Triple click to select all
        await page.keyboard.press('Backspace')
        
        # Type the phone number with a slight delay
        await page.type('#phone', PHONE_NUMBER, delay=100)
        
        # Add random delay before clicking next button (500-1500ms)
        await page.wait_for_timeout(500 + random.randint(0, 1000))
        
        # Click the next button
        await page.click('#wb-auto-1 > form > div.submit-container > button')
        
        # Wait for the next page to load
        await page.wait_for_selector('#wb-auto-2 > form > div > div:nth-child(3) > div', timeout=10000)
        
        await page.wait_for_timeout(999999999)

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())