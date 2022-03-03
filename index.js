const fs = require('fs')
const unzipper = require('unzipper')
const { XMLParser } = require("fast-xml-parser")
const inquirer = require('inquirer')

const SONG_FILE_NAME = 'Song.xml'

;(async function() {
  const { useConfig } = await inquirer.prompt([
    { type: "confirm", default: false, name: 'useConfig', message: "Use config file?" },
  ])

  if (useConfig) {
    return openConfigAndRun()
  }

  const { filename } = await inquirer.prompt([
    { type: "input:", default: 'file.xrns', name: 'filename', message: "Filename: " },
  ])

  // this needa happen
  await unzip(filename)

  const parser = new XMLParser({ ignoreAttributes: false })
  const song = fs.readFileSync(`./tmp/${SONG_FILE_NAME}`)
  let jObj = parser.parse(song)

  const AllTracks = jObj.RenoiseSong.Tracks.SequencerTrack.map(({ Name }) => Name)

  const { tracks } = await inquirer.prompt([
    { type: "checkbox", name: 'tracks', choices: AllTracks }
  ])

  if (!tracks.length) {
    throw new Error('You must select at least one track')
  }

  const tracksIndex = tracks.map(name => AllTracks.indexOf(name))

  const options = await tracksIndex.reduce(async (p, index) => {
    return p.then(async res => {
      const { options } = await inquirer.prompt([
        { 
          type: 'checkbox', 
          name: 'options', 
          default: ['Instruments'],
          choices: [
            "Instruments",
            "Effects"
          ]
        }
      ])

      res.push(options)

      return res
    })
  }, Promise.resolve([]))

  const { output } = await inquirer.prompt([
    { type: "input", default: "output.json", name: 'output' }
  ])

  const { exportSong } = await inquirer.prompt([
    { type: "confirm", default: true, name: 'exportSong', message: 'Export Song.xml to JSON?' }
  ])

  const { exportConfig } = await inquirer.prompt([
    { type: "confirm", default: true, name: 'exportConfig', message: 'Export config file?' }
  ])

  const all = tracksIndex.map((trackIndex, index) => ({
    index: trackIndex,
    name: tracks[index],
    options: options[index]
  }))

  const config = {
      filename,
      tracks,
      output,
      exportSong,
      tracks: all
  }

  run(config, jObj.RenoiseSong)

  if(exportConfig) {
    fs.writeFileSync('./config.json', JSON.stringify(config, null, 2))
  }

}().catch(console.log))

async function openConfigAndRun() {
  const config = await JSON.parse(fs.readFileSync('./config.json'))

  await unzip(config.filename)

  const parser = new XMLParser({ ignoreAttributes: false })
  const song = fs.readFileSync(`./tmp/${SONG_FILE_NAME}`)
  let jObj = parser.parse(song)

  return run(config, jObj.RenoiseSong)
}

function unzip(filename) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(filename)
      .on('error', reject)
      .pipe(unzipper.Parse())
      .on('entry', function (entry) {
        if (entry.path === SONG_FILE_NAME) {
          entry.pipe(fs.createWriteStream(`./tmp/${SONG_FILE_NAME}`))
        } else {
          entry.autodrain()
        }
      })
      .on('finish', resolve)
  })
}

function run({ tracks: tracksToExport, output, exportSong }, song) {
  const instruments = song.Instruments.Instrument.map(({Name}, i) => ({ name: Name, number: i }))
  const pool = song.PatternPool.Patterns
  let patternSequencer = song.PatternSequence.SequenceEntries
  
  if (!pool || !pool.Pattern || !patternSequencer || !patternSequencer.SequenceEntry) {
    throw new Error("Your song appears empty, please make some music.")
  }

  patternSequencer = Array.isArray(patternSequencer.SequenceEntry) ? patternSequencer.SequenceEntry : [patternSequencer.SequenceEntry]

  const patterns = patternSequencer.map(({ Pattern: patternIndex }) => {
    const { Tracks, NumberOfLines, Name  } = pool.Pattern[patternIndex]

    const tr = Tracks.PatternTrack
      .map((o, i) => ({...o, index: i}))
      .filter((_, i) => tracksToExport.find(({ index }) => i === index))

    return tr.reduce((acc, { index, Lines = []}, trackIndex) => {
      const { Name: trackName  } = song.Tracks.SequencerTrack[index]
      let track = new Array(NumberOfLines).fill(null)
      const { options } = tracksToExport[trackIndex]

      let lines = Lines ? Lines : {}
      lines = Lines.Line ? Array.isArray(Lines.Line) ? Lines.Line : [Lines.Line] : []

      lines.forEach((line, lineIndex) => {
        if (!line) {
          return
        }

        const at_index = line['@_index']

        if (at_index > NumberOfLines - 1) {
          return
        }

        const row = {}

        if (options.includes('Instruments') && line.NoteColumns && line.NoteColumns.NoteColumn !== '') {
          const col = line.NoteColumns.NoteColumn
          const notes = Array.isArray(col) ? col.filter(v => v !== '') : [col]
          
          if (notes.length) {
            // yey for renoise storing instrument number in hex, because legacy 
            // but actually the instrument id is indeed a number, and that's why 
            // we cannot have the good things
            row.notes = notes.map(note => (note.Instrument && (note.Instrument = parseInt(note.Instrument, 16)), note))
          }
        }

        if (options.includes('Effects') && line.EffectColumns && line.EffectColumns.EffectColumn !== '') {
          const col = line.EffectColumns.EffectColumn
          const effects = Array.isArray(col) ? col.filter(v => v !== '') : [col]

          if (effects.length) {
            row.effects = effects.map(effect => (effect.Value && (effect.Value = parseInt(effect.Value, 16)), effect))
          }
        }

        if (Object.keys(row).length === 0) {
          track[at_index] = null
        } else {
          track[at_index] = row
        }
      })

      track[0] = track[0] ? { ...track[0], section: Name || "" } : { section: Name || "" }
      acc[trackName] = track

      return acc
    }, {})
  }).reduce((acc, curr) => {
    const entries = Object.entries(curr)
    // console.log(entries)
    const merged = entries.map(entry => entry[1]).reduce(( acc, pat ) => {
      if (!acc.length) 
        return pat

      return acc.map(( pacc, i ) => {
        ['notes', 'effects'].forEach(prop => {
          if (pacc && pat[i] && pat[i][prop]) 
            pacc[prop] = [...pacc[prop] || [], ...pat[i][prop] || [] ]
          else if (pat[i] && pat[i][prop]) {
            pacc = {}
            pacc[prop] = pat[i][prop]
          }
        })

        return pacc
      })
    })

    return [...acc, ...merged]
  }, [])

  if (exportSong) {
    fs.writeFileSync('./output/song.json', JSON.stringify(song, null, 2))
  }

  fs.writeFileSync(`./output/${output}`, JSON.stringify({ globals: keepProperties(song.GlobalSongData, [
    "BeatsPerMin",
    "LinesPerBeat",
    "TicksPerLine",
    "SignatureNumerator",
    "SignatureDenominator",
  ]), instruments, patterns }, null, 2))
  
  fs.unlinkSync(`./tmp/${SONG_FILE_NAME}`)
}

function keepProperties(o, props) {
  return Object
    .entries(o)
    .filter(([prop]) => 
      props.includes(prop)
    )
    .reduce((acc, [key, value]) => {
      acc[key] = value
      return acc
    }, {})
}
