// This file is part of nbind, copyright (C) 2014-2016 BusFaster Ltd.
// Released under the MIT license, see LICENSE.

export var {
	Type, makeType, structureList
} = typeModule(typeModule);

export type PolicyTbl = { [name: string]: boolean };

export interface TypeSpec {
	[key: string]: any;

	id: number;
	name?: string;
	flags: TypeFlags;

	ptrSize?: number;
	paramList?: any[];
}

export interface TypeClass extends TypeSpec {
	toString?(): string;

	makeWireRead?(expr: string, convertParamList?: any[], num?: number): string;
	makeWireWrite?(
		expr: string,
		policyTbl?: PolicyTbl,
		convertParamList?: any[],
		num?: number
	): string | ((arg: any) => number);

	wireRead?: (arg: number) => any;
	wireWrite?: (arg: any) => number;

	spec?: TypeSpec;
}

export const enum TypeFlagBase {
	flag = 1,
	ref = flag * 4,
	kind = ref * 8,
	num = kind * 16
}

// These must match Policy.h.

export const enum TypeFlags {
	none = 0,

	flagMask = TypeFlagBase.flag * 3,
	isConst = TypeFlagBase.flag * 1,
	isValueObject = TypeFlagBase.flag * 2,

	refMask = TypeFlagBase.ref * 7,
	isPointer = TypeFlagBase.ref * 1,
	isReference = TypeFlagBase.ref * 2,
	isRvalueRef = TypeFlagBase.ref * 3,
	isSharedPtr = TypeFlagBase.ref * 4,
	isUniquePtr = TypeFlagBase.ref * 5,

	kindMask = TypeFlagBase.kind * 15,
	isPrimitive = TypeFlagBase.kind * 1,
	isClass = TypeFlagBase.kind * 2,
	isClassPtr = TypeFlagBase.kind * 3,
	isVector = TypeFlagBase.kind * 4,
	isArray = TypeFlagBase.kind * 5,
	isCString = TypeFlagBase.kind * 6,
	isString = TypeFlagBase.kind * 7,
	isOther = TypeFlagBase.kind * 8,

	numMask = TypeFlagBase.num * 15,
	isUnsigned = TypeFlagBase.num * 1,
	isSignless = TypeFlagBase.num * 2,
	isFloat = TypeFlagBase.num * 4,
	isBig = TypeFlagBase.num * 8
}

// These must match C++ enum StructureType in TypeID.h

export const enum StructureType {
	raw = 0,
	constant,
	pointer,
	reference,
	rvalue,
	vector,
	array,
	max
}

export type MakeTypeTbl = { [flags: number]: { new(spec: TypeSpec): TypeClass } };

/* tslint:disable:no-shadowed-variable */
export function typeModule(self: any) {

	// Printable name of each StructureType.

	type Structure = [TypeFlags, string];
	const structureList: Structure[] = [
		[0, 'X'],
		[TypeFlags.isConst, 'const X'],
		[TypeFlags.isPointer, 'X *'],
		[TypeFlags.isReference, 'X &'],
		[TypeFlags.isRvalueRef, 'X &&'],
		[TypeFlags.isVector, 'std::vector<X>'],
		[TypeFlags.isArray, 'std::array<X, Y>']
	];

	function applyStructure(
		outerName: string,
		outerFlags: TypeFlags,
		innerName: string,
		innerFlags: TypeFlags,
		flip?: boolean
	) {
		if(outerFlags == TypeFlags.isConst) {
			const ref = innerFlags & TypeFlags.refMask;
			if(
				ref == TypeFlags.isPointer ||
				ref == TypeFlags.isReference ||
				ref == TypeFlags.isRvalueRef
			) outerName = 'X const';
		}

		let name: string;

		if(flip) {
			name = innerName.replace('X', outerName);
		} else {
			name = outerName.replace('X', innerName);
		}

		// Remove spaces between consecutive * and & characters.
		return(name.replace(/([*&]) (?=[*&])/g, '$1'));
	}

	function reportProblem(
		problem: string,
		id: number,
		kind: string,
		structureType: StructureType,
		place: string
	) {
		throw(new Error(
			problem + ' type ' +
			kind.replace('X', id + '?') +
			(structureType ? ' with flag ' + structureType : '') +
			' in ' + place
		));
	}

	function getComplexType(
		id: number,
		makeTypeTbl: MakeTypeTbl,
		getType: (id: number) => TypeClass,
		queryType: (id: number) => {
			placeholderFlag: number,
			paramList: number[]
		},
		place?: string,
		// C++ type name string built top-down, for printing helpful errors.
		kind = 'X', // tslint:disable-line
		// Outer type, used only for updating kind.
		prevStructure: Structure = null, // tslint:disable-line
		depth: number = 1 // tslint:disable-line
	) {
		const result = queryType(id);
		const structureType: StructureType = result.placeholderFlag;

		let structure = structureList[structureType];

		if(prevStructure && structure) {
			kind = applyStructure(
				prevStructure[1], prevStructure[0],
				kind, structure[0],
				true
			);
		}

		let problem: string;

		if(structureType == 0) problem = 'Unbound';
		if(structureType >= StructureType.max) problem = 'Corrupt';
		if(depth > 20) problem = 'Deeply nested';

		if(problem) reportProblem(problem, id, kind, structureType, place);

		const subId = result.paramList[0];
		const subType = getType(subId) || getComplexType(
			subId,
			makeTypeTbl,
			getType,
			queryType,
			place,
			kind,
			structure,
			depth + 1
		);

		const name = applyStructure(
			structure[1], structure[0],
			subType.name, subType.flags
		);

		// Note: at every recursion depth the full type name is:
		// applyStructure(kind, 0, name, 0)
		// (combining top-down and bottom-up parts).

		// console.log(applyStructure(kind, 0, name, 0) + ' - ' + name); // tslint:disable-line

		let srcSpec: TypeSpec;
		let spec: TypeSpec = {
			flags: TypeFlags.isOther,
			id: id,
			name: name,
			paramList: [subType]
		};

		switch(result.placeholderFlag) {
			case StructureType.constant:
				spec.flags = TypeFlags.isConst;
				srcSpec = subType.spec;
				break;

			case StructureType.pointer:
				if((subType.flags & TypeFlags.kindMask) == TypeFlags.isPrimitive && subType.ptrSize == 1) {
					spec.flags = TypeFlags.isCString;
					break;
				}

				spec.flags = TypeFlags.isPointer; // TODO: or isReference!

				// tslint:disable-next-line:no-switch-case-fall-through
			case StructureType.reference:
				if(spec.flags != TypeFlags.isPointer) spec.flags = TypeFlags.isReference;
				srcSpec = subType.spec;

				if((subType.flags & TypeFlags.kindMask) != TypeFlags.isClass) {
					// reportProblem('Unsupported', id, kind, structureType, place);
				}
				break;

			case StructureType.vector:
				spec.flags = TypeFlags.isVector;
				break;

			case StructureType.array:
				spec.flags = TypeFlags.isArray;
				spec.paramList.push(result.paramList[1]);
				break;

			default:
				break;
		}

		if(srcSpec) {
			for(let key of Object.keys(srcSpec)) {
				spec[key] = spec[key] || srcSpec[key];
			}

			spec.flags |= srcSpec.flags;
		}

		return(makeType(makeTypeTbl, spec));
	}

	function makeType(makeTypeTbl: MakeTypeTbl, spec: TypeSpec) {
		const flags = spec.flags;
		const refKind = flags & TypeFlags.refMask;
		let kind = flags & TypeFlags.kindMask;

		if(!spec.name && kind == TypeFlags.isPrimitive) {
			if(flags & TypeFlags.isSignless) {
				spec.name = 'char';
			} else {
				spec.name = (
					(flags & TypeFlags.isUnsigned ? 'u' : '') +
					(flags & TypeFlags.isFloat ? 'float' : 'int') +
					(spec.ptrSize * 8 + '_t')
				);
			}
		}

		if(spec.ptrSize == 8 && !(flags & TypeFlags.isFloat)) kind = TypeFlags.isBig;
		if(kind == TypeFlags.isClass && refKind) kind = TypeFlags.isClassPtr;

		if(!makeTypeTbl[kind]) {
			console.log(makeTypeTbl); // tslint:disable-line
			console.log(kind); // tslint:disable-line
			console.log(flags); // tslint:disable-line
		}

		return(new makeTypeTbl[kind](spec));
	}

	class Type implements TypeClass {
		constructor(spec: TypeSpec) {
			this.id = spec.id;
			this.name = spec.name;
			this.flags = spec.flags;
			this.spec = spec;
		}

		toString() {
			return(this.name);
		}

		id: number;
		name: string;
		flags: TypeFlags;
		spec: TypeSpec;
	}

	const output = {
		Type: Type as { new(spec: TypeSpec): TypeClass },
		getComplexType: getComplexType,
		makeType: makeType,
		structureList: structureList
	};

	self.output = output;

	return((self.output || output) as typeof output);
}
