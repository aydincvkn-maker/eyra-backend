const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("ffmpeg-static");

const eyraAssetsPath = "c:\\Users\\Casper\\Desktop\\eyra\\assets";

const mp4Files = [
  "vip/rolex.mp4",
  "temel/hi.mp4",
  "premium/yuzen_panda.mp4",
  "premium/love_kiss.mp4",
  "premium/love.mp4",
  "premium/love kiss.mp4",
];

const command = (inputFile, outputFile) => {
  return `"${ffmpeg}" -i "${inputFile}" -vf "scale=360:-2,fps=24" -c:v libx264 -profile:v baseline -level 3.0 -pix_fmt yuv420p -movflags +faststart -an "${outputFile}"`;
};

async function encodeVideos() {
  for (const file of mp4Files) {
    const fullPath = path.join(eyraAssetsPath, file);
    const outputPath = fullPath.replace(".mp4", "_compat.mp4");

    if (!fs.existsSync(fullPath)) {
      console.log(`✗ File not found: ${fullPath}`);
      continue;
    }

    console.log(`\n🎬 Encoding: ${file}`);
    console.log(`   Input:  ${fullPath}`);
    console.log(`   Output: ${outputPath}`);

    try {
      const cmd = command(fullPath, outputPath);
      console.log(`   Command: ${cmd.substring(0, 100)}...`);
      execSync(cmd, { stdio: "inherit" });
      console.log(`✓ Encoded successfully`);

      // Replace original with encoded version
      console.log(`   Replacing original file...`);
      fs.unlinkSync(fullPath);
      fs.renameSync(outputPath, fullPath);
      console.log(`✓ Original file replaced`);
    } catch (error) {
      console.error(`✗ Error encoding ${file}:`, error.message);
    }
  }

  console.log("\n✓ All files processed!");
}

encodeVideos();
